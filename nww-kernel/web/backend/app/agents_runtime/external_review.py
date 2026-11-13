"""external_review.py — 外脑独立评审模块。

设计动机（2026-11-05 用户 design review 裁定）：
  现状 nww-reviewer 与 narrative-writer 同属 Qwen 家族（writer=Chrome bridge qwen，
  reviewer=本地 omlx Qwen3.8-27B），风格同源 → 自评偏差严重。85 分门槛无 anchor、
  revise prompt 只丢维度码不告诉怎么改、净提升<3 即 stop 直接锁死进度。

本模块 0 侵入：
  1. 独立选桥：读 writer 当前 endpoint → 排除 → 按 label 优先级试其它三桥
     （gemini → chatgpt → deepseek；writer 是哪个就跳过哪个）。
  2. 黄金样章校准：把 基因库/ 爆款书名作为评分标尺写进 system prompt，
     给 85 分一个外部锚点（不塞全文，省 context）。
  3. 强制 deductions 输出：每维扣分必须带 {location, reason, fix_hint, expected_gain}，
     revise prompt 直接消费这份清单，不再只丢维度码。
  4. 失败降级：任一桥异常/超时/JSON 解析失败 → 自动切下一桥；全部失败 → 返回 None，
     pipeline 侧降级为只用自评分（不挂主链，不阻断写章）。
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from .. import llm_client, llm_config

logger = logging.getLogger(__name__)

# 外脑候选桥 label 优先级（writer 是哪个就跳过哪个）
_BRIDGE_PRIORITY = ("gemini", "chatgpt", "deepseek")

# label 别名映射（用户 UI 手滑拼错的常见变体 → 标准名）
_LABEL_ALIASES = {
    "chatgtp": "chatgpt",  # 用户 model_config.json 里拼错为 chatgtp
    "gpt": "chatgpt",
    "chat_gpt": "chatgpt",
}

# 外脑评审温度：低温 = 评审稳定，不发挥
_EXTERNAL_TEMPERATURE = 0.2
_EXTERNAL_MAX_TOKENS = 4096
_EXTERNAL_TIMEOUT_S = 600.0  # Chrome bridge 慢，给足

# 黄金样章库路径（项目根/基因库）
_GOLDEN_LIB_REL = Path("基因库")

# 评分锚点：85 分对标这些爆款的开篇水准（书名即可，不塞全文）
_GOLDEN_ANCHORS = [
    "赤心巡天（情何以甚）",
    "剑来（烽火戏诸侯）",
    "道诡异仙（狐尾的笔）",
    "诡秘之主（爱潜水的乌贼）",
    "玄鉴仙族（姬叉）",
]


def _norm_label(raw: str) -> str:
    """归一化 label：小写 + 别名映射。"""
    s = (raw or "").strip().lower()
    return _LABEL_ALIASES.get(s, s)


def _read_cfg() -> dict:
    try:
        return llm_config._read() or {}
    except Exception:  # noqa: BLE001
        return {}


def _writer_pool_id(cfg: dict) -> str:
    """当前 writer（narrative-writer）用的 pool id。"""
    routes = cfg.get("agent_routes") or {}
    return str(routes.get("narrative-writer") or cfg.get("default") or "").strip()


def _writer_label(cfg: dict, writer_pool_id: str) -> str:
    """从 pool entry 取 writer 的 label（qwen/gemini/chatgpt/deepseek），归一化后返回。"""
    pool = llm_config._pool_map(cfg) if hasattr(llm_config, "_pool_map") else {}
    if not pool:
        # 兜底：自己扫
        for m in cfg.get("pool", []) or []:
            if isinstance(m, dict) and m.get("id") == writer_pool_id:
                return _norm_label(str(m.get("label") or ""))
        return ""
    entry = pool.get(writer_pool_id) or {}
    return _norm_label(str(entry.get("label") or ""))


def candidate_external_bridges(cfg: dict | None = None) -> list[dict[str, Any]]:
    """返回外脑候选桥列表，按优先级排序，已排除 writer 自己。

    每项: {pool_id, label, base_url, model, api_key}
    """
    cfg = cfg or _read_cfg()
    if not cfg:
        return []
    writer_id = _writer_pool_id(cfg)
    writer_label = _writer_label(cfg, writer_id)

    # 收集所有 label 在 _BRIDGE_PRIORITY 里的 pool entry
    cands: list[dict[str, Any]] = []
    pool_map = llm_config._pool_map(cfg) if hasattr(llm_config, "_pool_map") else {}
    prov_map = llm_config._provider_map(cfg) if hasattr(llm_config, "_provider_map") else {}
    if not pool_map:
        # 兜底自己建
        pool_map = {m.get("id"): m for m in cfg.get("pool", []) or [] if isinstance(m, dict)}
        prov_map = {p.get("id"): p for p in cfg.get("providers", []) or [] if isinstance(p, dict)}

    for pid, entry in pool_map.items():
        label = _norm_label(str(entry.get("label") or ""))
        if label not in _BRIDGE_PRIORITY:
            continue
        if pid == writer_id or label == writer_label:
            continue  # 排除 writer 同源桥
        prov = prov_map.get(entry.get("provider", "")) or {}
        if not prov or prov.get("enabled", True) is False:
            continue
        base = str(prov.get("base_url") or "").rstrip("/")
        model = str(entry.get("model") or "").strip()
        key = str(prov.get("api_key") or "")
        if not base or not model:
            continue
        cands.append({
            "pool_id": pid,
            "label": label,
            "base_url": base,
            "model": model,
            "api_key": key,
        })

    # 按 _BRIDGE_PRIORITY 排序（writer 已被排除，剩下的按 gemini→chatgpt→deepseek 排）
    order = {lab: i for i, lab in enumerate(_BRIDGE_PRIORITY)}
    cands.sort(key=lambda c: order.get(c["label"], 99))
    return cands


def _build_system_prompt() -> str:
    """外脑评审 system prompt：身份独立 + 黄金样章校准 + 输出契约。"""
    anchors = "\n".join(f"  - {name}" for name in _GOLDEN_ANCHORS)
    return (
        "你是一名与作者不同模型家族的外脑评审编辑，对标起点/番茄爆款的编辑视角。\n"
        "你不是作者本人，不要替作者脑补他'本来想表达什么'；只看正文实际写出来的东西。\n"
        "\n"
        "【评分锚点（85 分 = 这个水准）】\n"
        "下列作品是经过市场验证的爆款，它们的开篇章节质量就是 85-90 分的基准线：\n"
        f"{anchors}\n"
        "  - <70 分：读者前三章必弃书，节奏塌/对话尬/设定堆砌\n"
        "  - 70-84 分：能读但不出彩，有明显短板，编辑会打回要求改\n"
        "  - 85-90 分：爆款开篇水准，钩子/爽点/人物/语域四项至少三项在线\n"
        "  - 90+ 分：远超同卷平均水准，可直接推榜\n"
        "\n"
        "【输出契约 · 必须严格遵守】\n"
        "只输出一个 JSON 对象，不要 markdown 代码块包裹，不要任何解释文字。字段：\n"
        "{\n"
        '  "total": <0-100 综合分>,\n'
        '  "scores": {"I-A": <0-100>, ...},   // 按给定 rubric 逐维打分\n'
        '  "promise_audit": [{"outline_item": "...", "delivered": true/false, "evidence": "..."}],\n'
        '  "deductions": [\n'
        "    {\n"
        '      "dim": "I-E",\n'
        '      "location": "正文第X段/第X句/角色名XX",\n'
        '      "reason": "为什么扣分（具体到文字）",\n'
        '      "fix_hint": "改成什么样能到 85 分（具体动作，不要说加强描写）",\n'
        '      "expected_gain": <预计能加几分 0-10>\n'
        "    }\n"
        "  ]\n"
        "}\n"
        "deductions 必须覆盖所有 <85 的维度；每个扣分点必须能在正文里指认位置。\n"
        "禁止写'加强感染力/提升代入感'这类空话——fix_hint 必须是可执行的修改动作。"
    )


def _parse_external_response(text: str) -> dict | None:
    """解析外脑 LLM 返回的 JSON，失败返回 None。"""
    if not text:
        return None
    cleaned = text.strip()
    # 剥 markdown 代码块
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.S)
    # 找第一个 { 到最后一个 }
    lo = cleaned.find("{")
    hi = cleaned.rfind("}")
    if lo < 0 or hi <= lo:
        return None
    cleaned = cleaned[lo:hi + 1]
    try:
        data = json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(data, dict) or "total" not in data:
        return None
    try:
        total = max(0.0, min(100.0, float(data["total"])))
    except (TypeError, ValueError):
        return None
    scores = data.get("scores") if isinstance(data.get("scores"), dict) else None
    pa = data.get("promise_audit") if isinstance(data.get("promise_audit"), list) else None
    ded = data.get("deductions") if isinstance(data.get("deductions"), list) else []
    return {
        "total": total,
        "scores": scores,
        "promise_audit": pa,
        "deductions": ded,
    }


def review_external(score_prompt: str, prose_text: str,
                    chapter_id: int | None = None) -> dict | None:
    """跑外脑评审：按候选桥顺序试，第一个成功的返回结果。

    返回:
      {
        "bridge": "gemini" | "chatgpt" | "deepseek",
        "pool_id": "...",
        "total": float,
        "scores": dict | None,
        "promise_audit": list | None,
        "deductions": list,
      }
      全部桥失败 → None（调用方降级为只用自评分）。
    """
    cands = candidate_external_bridges()
    if not cands:
        logger.warning("[EXTERNAL_REVIEW] 无可用外脑桥（pool 里没有 gemini/chatgpt/deepseek，或全被 writer 占了）")
        return None

    sys_prompt = _build_system_prompt()
    user_prompt = (
        f"{score_prompt}\n\n"
        f"【本章正文】\n{prose_text[:10000]}\n\n"
        "请按上述 rubric 打分，并严格输出 deductions 清单。"
    )

    last_err = ""
    for c in cands:
        try:
            logger.info(f"[EXTERNAL_REVIEW] 尝试外脑桥: {c['label']} ({c['pool_id']})")
            text = llm_client.chat_completion(
                system_prompt=sys_prompt,
                user_prompt=user_prompt,
                temperature=_EXTERNAL_TEMPERATURE,
                max_tokens=_EXTERNAL_MAX_TOKENS,
                base_url=c["base_url"],
                model=c["model"],
                api_key=c["api_key"],
                timeout=_EXTERNAL_TIMEOUT_S,
            )
            parsed = _parse_external_response(text)
            if parsed is None:
                last_err = f"{c['label']}: JSON 解析失败"
                logger.warning(f"[EXTERNAL_REVIEW] {last_err}，切下一桥")
                continue
            logger.info(
                f"[EXTERNAL_REVIEW] ✓ {c['label']} 打分完成: total={parsed['total']:.1f}, "
                f"deductions={len(parsed.get('deductions') or [])}"
            )
            return {
                "bridge": c["label"],
                "pool_id": c["pool_id"],
                **parsed,
            }
        except Exception as exc:  # noqa: BLE001 — 单桥失败不挂主链
            last_err = f"{c['label']}: {type(exc).__name__}: {str(exc)[:200]}"
            logger.warning(f"[EXTERNAL_REVIEW] {last_err}，切下一桥")
            continue

    logger.error(f"[EXTERNAL_REVIEW] 所有外脑桥均失败: {last_err}")
    return None
