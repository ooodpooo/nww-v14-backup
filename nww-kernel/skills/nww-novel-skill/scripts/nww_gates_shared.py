#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""nww_gates_shared.py — 写章护栏共享库（Task 1 / C-P0-2）。

从 Web pipeline 下沉的确定性纯函数 + 对现有脚本的薄封装，供 CLI
`nww_write_chapter` 与 Web `pipeline.py` 共用，避免三入口护栏分裂。

禁止在此复制巨型 pipeline 业务体；LLM 步骤仍留在 Web。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

_REPO_ROOT = SCRIPT_DIR.parents[2]
_ENGINE_SCRIPTS = _REPO_ROOT / "engine" / "scripts"
_PY = sys.executable

ENFORCE_SCRIPT = SCRIPT_DIR / "nww_enforce.py"
POST_WRITE_SCRIPT = SCRIPT_DIR / "nww_post_write.py"
PARAGRAPH_GATE_SCRIPT = SCRIPT_DIR / "nww_paragraph_gate.py"
PACKET_V2_SKILL = SCRIPT_DIR / "nww_packet_builder_v2.py"
PACKET_V2_ENGINE = _ENGINE_SCRIPTS / "nww_packet_builder_v2.py"

# ---------------------------------------------------------------------------
# 未注册实体代称词表（2026-10-30 外脑第四轮裁决三：Local_Actor 段落归属）
# ---------------------------------------------------------------------------
# 个体身份代称（非专名）；已注册角色（有卡/入追踪 state）不进词表，由段落归属
# 的 present 机制处理。群体通称（「修士」「众人」等）故意不入表：误触发面过大，
# 会削弱主角代词统计效力（外脑裁决：宁严勿漏）。书级扩展：追踪 state 的
# local_actor_terms 列表（可选字段），见 local_actor_terms()。
LOCAL_ACTOR_TERMS = frozenset({
    "散修", "老者", "老翁", "老妪", "老妇", "童子", "少年", "少女", "青年",
    "汉子", "大汉", "婆子", "妇人", "孩子", "小孩", "书生", "乞丐",
    "道人", "道姑", "僧人", "尼姑", "摊主", "掌柜", "伙计", "小二",
    "路人", "行商", "货郎", "车夫", "樵夫", "猎户", "铁匠", "郎中",
    "侍女", "婢女", "小厮", "护卫", "镖师", "管事",
})

# LOCAL 段落归属哨兵：该区域代词从主角统计池剔除（subject 不在主角锚集合）
_LOCAL_ACTOR = "__local_actor__"


# ---------------------------------------------------------------------------
# packet contract repair（纯函数，自 pipeline 下沉）
# ---------------------------------------------------------------------------

def character_contract_from_cards(book: Path, packet: dict) -> list[dict]:
    """character_contract 为空时从 设定/角色/*.md 兜底构建最小 voice 合同。"""
    card_dir = book / "设定" / "角色"
    if not card_dir.is_dir():
        return []
    ctx = json.dumps({"scene_chain": packet.get("scene_chain"),
                      "intent": packet.get("intent")}, ensure_ascii=False)
    out: list[dict] = []
    protagonist_name = ""
    try:
        _bible = json.loads((book / "bible.json").read_text(encoding="utf-8"))
        protagonist_name = re.sub(
            r"^主角", "", str((_bible.get("protagonist") or {}).get("name") or "")
        ).strip()
    except Exception:  # noqa: BLE001
        pass
    for p in sorted(card_dir.glob("*.md"))[:8]:
        name = p.stem
        try:
            lines = [ln.strip() for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip()]
        except Exception:  # noqa: BLE001
            continue
        if name not in ctx and not (protagonist_name and protagonist_name in name and not out):
            continue
        head = "\n".join(lines[:5])
        voice = [ln[:160] for ln in lines if re.search(r"口头禅|口癖|句式|习惯动作|性格", ln)][:3]
        behavior = [ln[:160] for ln in lines if "禁" in ln][:2]
        out.append({
            "name": name,
            "role": "主角" if re.search(r"女主|主角|男主", head) else "",
            "voice_constraints": voice or [
                f"（角色卡兜底，详见 设定/角色/{name}.md 首段）{head[:120]}"
            ],
            "behavior_constraints": behavior,
            "state": "",
        })
    return out


def facts_from_bible(book: Path) -> list[dict]:
    """首章/无前情时从 bible.json 构建初始已认证事实。"""
    try:
        bible = json.loads((book / "bible.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    out: list[dict] = []
    protag = bible.get("protagonist") or {}
    pname = re.sub(r"^主角", "", str(protag.get("name") or "")).strip()
    desc = str(protag.get("description") or "").strip()
    if pname and desc:
        out.append({
            "id": "bible-protagonist", "subject": pname, "predicate": "身份设定",
            "value": desc[:200], "fact": f"{pname}：{desc[:200]}",
            "fact_type": "identity",
            "evidence": {"chapter": 0, "quote": "bible.json protagonist"},
        })
    syn = str(bible.get("synopsis") or bible.get("world_summary") or "").strip()
    if syn:
        out.append({
            "id": "bible-synopsis", "subject": "", "predicate": "世界观基线",
            "value": syn[:300], "fact": syn[:300], "fact_type": "worldview",
            "evidence": {"chapter": 0, "quote": "bible.json synopsis"},
        })
    return out


def repair_packet_contract(book: Path, chapter_id: int, packet: dict) -> dict:
    """packet 合同修复闸（P0-2，写章链 BLOCK 点）。

    ① character_contract 为空 → 设定/角色卡兜底注入；
    ② 兜底后仍为空 → BLOCK（NWW_PACKET_STRICT=0 降级 WARNING）；
    ③ facts.confirmed 为空 → bible 兜底注入。
    """
    meta = packet.get("meta") or {}
    strict = os.environ.get("NWW_PACKET_STRICT", "1") != "0"
    problems: list[str] = []
    if not packet.get("character_contract"):
        injected = character_contract_from_cards(book, packet)
        if injected:
            packet["character_contract"] = injected
            meta["missing"] = [m for m in (meta.get("missing") or []) if m != "出场角色voice锚点"]
            if meta.get("parse_status") not in (None, "FULL"):
                meta["parse_status"] = "REPAIRED"
            print(
                f"[P02-REPAIR] character_contract 为空 → 设定/角色卡兜底注入 {len(injected)} 条"
                f"（{[c['name'] for c in injected]}）",
                flush=True,
            )
        else:
            problems.append("出场角色voice锚点缺失，且 设定/角色/ 无本章角色卡可兜底")
    facts = packet.get("facts") or {}
    if not facts.get("confirmed"):
        bf = facts_from_bible(book)
        if bf:
            facts["confirmed"] = bf
            facts.setdefault("meta", {})["reason"] = "bible_fallback_no_confirmed_facts"
            packet["facts"] = facts
            print(f"[P02-REPAIR] facts.confirmed 为空 → bible 兜底注入 {len(bf)} 条", flush=True)
    packet["meta"] = meta
    if problems:
        msg = "；".join(problems)
        if strict:
            raise RuntimeError(
                f"[PACKET_GATE] BLOCK: {msg} —— 请在细纲补充「出场角色 voice 锚点」小节，"
                f"或在 设定/角色/ 为本章角色创建角色卡后重试（NWW_PACKET_STRICT=0 可临时降级放行）"
            )
        print(f"[PACKET_GATE][WARNING] {msg}（NWW_PACKET_STRICT=0 降级放行）", flush=True)
    return packet


# ---------------------------------------------------------------------------
# pronoun gate（纯函数，自 pipeline 下沉）
# ---------------------------------------------------------------------------

def contract_sidecar_path(book: Path, chapter_id: int) -> Path | None:
    """本章写作合同 sidecar 路径（双命名变体统一收口）。"""
    for name in (
        f"细纲_第{chapter_id:03d}章.contract.json",
        f"细纲_{chapter_id:03d}章.contract.json",
    ):
        p = book / "大纲" / name
        if p.is_file():
            return p
    return None


def _card_explicit_name(head: str) -> str:
    """主角卡头 8 行显式姓名字段（姓名/名字/角色名/名称）；无则空。"""
    m = re.search(r"(?:姓名|名字|角色名|名称)\s*[：:]\s*(\S[^\n]{0,30})", head)
    return m.group(1).strip() if m else ""


def _card_has_gender_decl(head: str) -> bool:
    """卡头是否含任一性别声明（显式字段或旧标注，不判定冲突，仅判定存在性）。"""
    return bool(
        re.search(r"性别\s*[：:]\s*(男|女)", head)
        or re.search(r"女主|（女）|女主角", head)
        or re.search(r"男主|（男）|男主角", head)
    )


def resolve_protagonist_anchor(book: Path) -> tuple[set[str], str, Path | None]:
    """主角锚解析回退链（2026-10-30 外脑裁决增强版 B，双端同口径）。

    返回 (主角名集合, 锚来源, 主角卡路径或 None)。
    优先级：
      1. bible.json protagonist.name —— 有 bible 的书走原路径，零影响；
      2. 主角卡定位（无 bible/无名时）：追踪 state characters ∩ 卡 stem 唯一者；
         否则「头 8 行含性别声明的卡」唯一者（兼容旧唯一性别卡行为，且修复
         多卡带性别声明时按文件名序互相遮蔽的缺陷）；
      3. 主角名：卡头 8 行显式姓名字段优先，其次 stem（stem 已由 state 印证
         或唯一性别卡定位）。
    全部失败返回 ({}, "none", None) —— 代词闸按主角锚缺失警示跳过，不静默 0 计数。
    """
    card_dir = book / "设定" / "角色"
    cards = sorted(card_dir.glob("*.md")) if card_dir.is_dir() else []

    pname = ""
    try:
        bible = json.loads((book / "bible.json").read_text(encoding="utf-8"))
        pname = re.sub(r"^主角", "", str((bible.get("protagonist") or {}).get("name") or "")).strip()
    except Exception:  # noqa: BLE001
        pass
    if pname:
        for p in cards:
            if pname in p.stem or p.stem in pname:
                return {pname}, "bible", p
        return {pname}, "bible", None

    state_names: set[str] = set()
    try:
        state = json.loads((book / "追踪" / "_tracking-state.json").read_text(encoding="utf-8"))
        state_names = {str(k) for k in (state.get("characters") or {}) if k}
    except Exception:  # noqa: BLE001
        pass
    anchor_card: Path | None = None
    source = "none"
    if state_names:
        matched = [p for p in cards if p.stem in state_names]
        if len(matched) == 1:
            anchor_card, source = matched[0], "trace_state"
    if anchor_card is None:
        gendered = []
        for p in cards:
            try:
                head = "\n".join(p.read_text(encoding="utf-8").splitlines()[:8])
            except Exception:  # noqa: BLE001
                continue
            if _card_has_gender_decl(head):
                gendered.append(p)
        if len(gendered) == 1:
            anchor_card, source = gendered[0], "gender_card"
    if anchor_card is None:
        return set(), "none", None

    try:
        head = "\n".join(anchor_card.read_text(encoding="utf-8").splitlines()[:8])
    except Exception:  # noqa: BLE001
        return set(), source, anchor_card
    name = _card_explicit_name(head)
    return ({name} if name else {anchor_card.stem}), source, anchor_card


def protagonist_gender(book: Path) -> str:
    """主角性别声明（仅认主角卡头 8 行的显式标注；无声明返回空）。

    主角卡由 resolve_protagonist_anchor 定位（bible → 追踪 state 印证 → 唯一性别卡），
    与代词闸统计锚源统一（2026-10-30 外脑裁决）。
    识别优先级：
    1. 标准字段「性别：男/女」（全角/半角冒号、前置列表符号/空格均可）；
    2. 回退旧标注：女主/女主角/（女）、男主/男主角/（男）；
    3. 显式字段与旧标注冲突、或同一卡同时命中男女旧标注 → 返回空
       （代词闸按缺失警示跳过，性别审计模块报冲突 WARNING，不静默选择）。
    """
    _names, _source, card = resolve_protagonist_anchor(book)
    if card is None:
        return ""
    try:
        head = "\n".join(card.read_text(encoding="utf-8").splitlines()[:8])
    except Exception:  # noqa: BLE001
        return ""
    explicit_m = re.search(r"性别\s*[：:]\s*(男|女)", head)
    legacy_female = re.search(r"女主|（女）|女主角", head)
    legacy_male = re.search(r"男主|（男）|男主角", head)
    if legacy_female and legacy_male:
        return ""
    explicit = {"男": "male", "女": "female"}.get(explicit_m.group(1)) if explicit_m else ""
    if explicit:
        if (explicit == "female" and legacy_male) or (explicit == "male" and legacy_female):
            return ""
        return explicit
    if legacy_female:
        return "female"
    if legacy_male:
        return "male"
    return ""


def pronoun_gate_known_names(book: Path, chapter_id: int) -> set[str]:
    """闸用角色名集合：主角卡名 + 本章 sidecar/细纲出场角色。"""
    names: set[str] = set()
    try:
        bible = json.loads((book / "bible.json").read_text(encoding="utf-8"))
        pname = re.sub(r"^主角", "", str((bible.get("protagonist") or {}).get("name") or "")).strip()
        if pname:
            names.add(pname)
    except Exception:  # noqa: BLE001
        pass
    try:
        state = json.loads((book / "追踪" / "_tracking-state.json").read_text(encoding="utf-8"))
        for k in (state.get("characters") or {}):
            if k:
                names.add(str(k))
    except Exception:  # noqa: BLE001
        pass
    sc = contract_sidecar_path(book, chapter_id)
    if sc is not None:
        try:
            for c in (json.loads(sc.read_text(encoding="utf-8")).get("characters") or []):
                if c.get("name"):
                    names.add(str(c["name"]))
        except Exception:  # noqa: BLE001
            pass
    return names


def local_actor_terms(book: Path) -> frozenset[str]:
    """未注册实体代称词表：内置 LOCAL_ACTOR_TERMS + 书级扩展（追踪 state 可选字段
    local_actor_terms）。已注册角色不进词表，由段落归属 present 机制处理。"""
    terms = set(LOCAL_ACTOR_TERMS)
    try:
        state = json.loads((book / "追踪" / "_tracking-state.json").read_text(encoding="utf-8"))
        for t in (state.get("local_actor_terms") or []):
            if str(t).strip():
                terms.add(str(t).strip())
    except Exception:  # noqa: BLE001 — state 缺失/损坏时退回内置词表
        pass
    return frozenset(terms)


def protagonist_pronoun_counts(
    book: Path, chapter_id: int, prose_text: str,
    proto_names: set[str] | None = None, gender: str | None = None,
) -> tuple[int, int]:
    """主角段代词计数（段落归属核心；pronoun_gate 与认知误认审计共用口径）。

    段落归属规则（2026-10-30 外脑第四轮裁决三 Local_Actor 机制 + 实测修正）：
      段落含唯一已注册名 → subject=该名；含多个 → 跳过（归属歧义，subject 保持）；
      含 0 个且含未注册实体代称 → LOCAL 接管，该区域代词从主角统计池剔除，
      但段内出现主角正向代词（female→她 / male→他）时视为「主角未点名的延续交错段」
      计入主角统计（宁严勿漏；实证：第 1 章老妪买水段「她掏出铜板/多看了她一眼」，
      主角名不在段内、行为主体是主角，无条件 LOCAL 会误剔 她×4）；
      LOCAL 跨段沿用，直至段落再次出现主角名/已注册名才重置（延续段如「那号人。他…」
      不因段落边界回落到主角——实测第 1 章 L55→L57 场景）；
      段落同时含主角名与实体代称（歧义）→ 计入主角统计（宁严勿漏）。
    返回 subject ∈ 主角锚 的段落 (他, 她) 计数。"""
    body = re.sub(r"^[#\s]*第\s*\d+\s*章.*$", "", prose_text or "", flags=re.M)
    body = re.sub(r"“[^”]{0,400}”|「[^」]{0,400}」|\"[^\"]{0,400}\"", "", body)
    if proto_names is None:
        proto_names, _source, _card = resolve_protagonist_anchor(book)
    if gender is None:
        gender = protagonist_gender(book)
    names = pronoun_gate_known_names(book, chapter_id)
    names.update(proto_names)
    terms = local_actor_terms(book)
    forward = "她" if gender == "female" else "他"
    he_p = she_p = 0
    subject = ""  # 最近一次唯一点名的已注册角色；未注册实体区域为 _LOCAL_ACTOR 哨兵
    for para in re.split(r"\n+", body):
        para = para.strip()
        if not para:
            continue
        present = [n for n in names if n and n in para]
        if len(present) == 1:
            subject = present[0]
        elif len(present) > 1:
            continue  # 多角色同段，代词归属歧义
        elif terms and any(t in para for t in terms) and forward not in para:
            subject = _LOCAL_ACTOR  # 未注册实体代称且无主角正向代词 → LOCAL 接管
        if subject in proto_names:
            he_p += len(re.findall(r"他", para))
            she_p += len(re.findall(r"她", para))
    return he_p, she_p


def pronoun_gate_check(book: Path, chapter_id: int, prose_text: str) -> tuple[bool, str]:
    """代词性别机械闸（P0-3）：叙述层代词按主语归属统计 vs 角色卡性别声明。

    主角锚由 resolve_protagonist_anchor 解析（bible → 追踪 state → 唯一性别卡回退链，
    2026-10-30 外脑裁决增强版 B）；锚缺失时警示跳过，不再静默 0 计数空转。
    段落归属含 Local_Actor 机制（未注册实体代称区域剔除，见 protagonist_pronoun_counts）。"""
    if os.environ.get("NWW_PRONOUN_GATE", "1") == "0":
        return True, "代词闸已关闭"
    proto_names, anchor_source, _anchor_card = resolve_protagonist_anchor(book)
    gender = protagonist_gender(book)
    if not proto_names:
        return True, "主角锚缺失，代词闸跳过（WARNING：无法确定主角名，请检查 bible.json protagonist.name 或 设定/角色/ 主角卡命名，否则代词闸不生效）"
    if not gender:
        return True, "无角色卡性别声明，代词闸跳过（WARNING：主角性别未登记，请在 设定/角色/ 主角卡头 8 行补「性别：男/女」，否则代词闸不生效）"
    he_p, she_p = protagonist_pronoun_counts(
        book, chapter_id, prose_text, proto_names=proto_names, gender=gender)
    proto_name = sorted(proto_names)[0]
    label = "女性" if gender == "female" else "男性"
    wrong = "他" if gender == "female" else "她"
    right = "她" if gender == "female" else "他"
    wrong_p = he_p if gender == "female" else she_p
    right_p = she_p if gender == "female" else he_p
    if wrong_p >= 8 and wrong_p > right_p * 0.5:
        return False, (
            f"叙述层代词性别错位：视角主角（{proto_name}，角色卡判定{label}）"
            f"被以「{wrong}」指称 ×{wrong_p}，而「{right}」×{right_p}"
            "——请核查视角角色代词（对照 设定/角色/ 性别声明）"
        )
    return True, f"代词性别一致（{label}主角{proto_name or ''}，锚={anchor_source}；{wrong}×{wrong_p}/{right}×{right_p}）"


# ---------------------------------------------------------------------------
# 薄封装：调现有脚本（subprocess，加载最新代码）
# ---------------------------------------------------------------------------

# 路径标志（与 toolbox._assert_paths_within 对齐）：Web 多书隔离时传入 path_root
_PATH_ARG_HINTS = ("--project", "--book", "--prose", "--out", "--input", "--file")


def assert_paths_within(args: list[str], path_root: Path) -> None:
    """防御式路径隔离：args 中出现的绝对/相对逃逸路径必须位于 path_root 内。

    从 Web toolbox._assert_paths_within 移植；CLI 不传 path_root 时跳过校验。
    """
    root = Path(path_root).resolve()
    for i, a in enumerate(args):
        prev = args[i - 1] if i > 0 else ""
        candidate = a if prev in _PATH_ARG_HINTS or not str(a).startswith("-") else None
        if candidate is None:
            continue
        p = Path(candidate).expanduser()
        if p.is_absolute() or (p.parts and p.parts[0] in {".", ".."}):
            resolved = p.resolve()
            if not resolved.is_relative_to(root):
                raise PermissionError(f"路径逃逸工作区，拒绝执行: {candidate}")


def _run_script(
    script: Path,
    args: list[str],
    timeout: int,
    *,
    label: str,
    path_root: Path | None = None,
) -> dict[str, Any]:
    if path_root is not None:
        assert_paths_within(args, path_root)
    cmd = [_PY, str(script), *args]
    start = time.monotonic()
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(SCRIPT_DIR),
        )
        return {
            "label": label,
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "elapsed_seconds": round(time.monotonic() - start, 2),
            "stdout": (proc.stdout or "").strip(),
            "stderr": (proc.stderr or "").strip(),
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "label": label,
            "ok": False,
            "returncode": -2,
            "elapsed_seconds": round(time.monotonic() - start, 2),
            "stdout": "",
            "stderr": f"EXEC_ERROR: {exc}",
        }


def run_paragraph_gate(prose: Path, *, path_root: Path | None = None) -> dict[str, Any]:
    """薄封装：nww_paragraph_gate.py。"""
    if not prose or not Path(prose).is_file():
        return {
            "label": "paragraph_gate",
            "ok": False,
            "returncode": -1,
            "stdout": "",
            "stderr": f"正文缺失: {prose}",
        }
    return _run_script(
        PARAGRAPH_GATE_SCRIPT,
        ["--prose", str(prose), "--json"],
        15,
        label="paragraph_gate",
        path_root=path_root,
    )


def run_enforce(book: Path, prose: Path, *, path_root: Path | None = None) -> dict[str, Any]:
    """薄封装：nww_enforce.py。"""
    if not prose or not Path(prose).is_file():
        return {
            "label": "enforce",
            "ok": False,
            "returncode": -1,
            "stdout": "",
            "stderr": f"正文缺失: {prose}",
        }
    return _run_script(
        ENFORCE_SCRIPT,
        ["--book", str(book), "--file", str(prose)],
        60,
        label="enforce",
        path_root=path_root,
    )


def run_post_write(
    book: Path,
    chapter_id: int,
    prose: Path | None,
    *,
    skip_enforce: bool = False,
    path_root: Path | None = None,
) -> dict[str, Any]:
    """薄封装：nww_post_write.py（paragraph_gate + commit + cross_chapter）。

    path_root：Web 传入书根以启用路径沙箱；CLI 省略。
    """
    if prose is None or not Path(prose).is_file():
        return {
            "label": "post_write",
            "ok": False,
            "returncode": 2,
            "stdout": "",
            "stderr": f"post_write BLOCK: 正文缺失 chapter={chapter_id} prose={prose}",
        }
    args = [
        "--project", str(book),
        "--chapter", str(chapter_id),
        "--prose", str(prose),
        "--json",
    ]
    if skip_enforce:
        args.append("--skip-enforce")
    return _run_script(
        POST_WRITE_SCRIPT, args, 300, label="post_write", path_root=path_root
    )


def run_deslop_advisory(book: Path, chapter_id: int, prose: Path | None) -> dict[str, Any]:
    """Task 5 接入前：deslop 仅 advisory / skip / ok 记录，不阻断。

    若正文缺失 → skip；否则尝试 check-ai-patterns.js --check（有 node 则跑，无则 skip）。
    """
    _ = book, chapter_id  # 预留 Task 5 quality_loop 签名对齐
    if prose is None or not Path(prose).is_file():
        return {"label": "deslop", "ok": True, "status": "skip", "stdout": "", "stderr": "no prose"}
    js = SCRIPT_DIR / "check-ai-patterns.js"
    if not js.is_file():
        return {"label": "deslop", "ok": True, "status": "skip", "stdout": "", "stderr": "script missing"}
    node = "node"
    try:
        proc = subprocess.run(
            [node, str(js), "--check", str(prose)],
            capture_output=True,
            text=True,
            timeout=180,
            cwd=str(SCRIPT_DIR),
        )
        # advisory：非 0 不阻断；status 仅区分检测是否报出模式
        return {
            "label": "deslop",
            "ok": True,
            "status": "ok" if proc.returncode == 0 else "advisory",
            "returncode": proc.returncode,
            "stdout": (proc.stdout or "")[:1200],
            "stderr": (proc.stderr or "")[:300],
        }
    except FileNotFoundError:
        return {"label": "deslop", "ok": True, "status": "skip", "stdout": "", "stderr": "node not found"}
    except Exception as exc:  # noqa: BLE001
        return {"label": "deslop", "ok": True, "status": "skip", "stdout": "", "stderr": str(exc)}


def build_packet_v2(
    book: Path,
    chapter_id: int,
    *,
    no_sidecar: bool = False,
    path_root: Path | None = None,
) -> dict:
    """调用 nww_packet_builder_v2（subprocess，避免 builder 内 sys.exit 污染调用方）。

    优先 skills 副本，回退 engine/scripts。
    path_root：Web 传入书根启用路径沙箱；CLI 省略。
    """
    script = PACKET_V2_SKILL if PACKET_V2_SKILL.is_file() else PACKET_V2_ENGINE
    if not script.is_file():
        raise RuntimeError(f"packet builder v2 缺失: {script}")
    args = [str(book), str(chapter_id)]
    if no_sidecar:
        args.append("--no-sidecar")
    if path_root is not None:
        assert_paths_within(args, path_root)
    # CLI: python nww_packet_builder_v2.py <book> <chapter_id>
    proc = subprocess.run(
        [_PY, str(script), *args],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(script.parent),
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip() or f"exit={proc.returncode}"
        raise RuntimeError(f"packet_v2 失败: {err}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"packet_v2 输出非 JSON: {exc}") from exc
