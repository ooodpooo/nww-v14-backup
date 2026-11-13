"""nww_rewrite_fuse.py — 单章重写熔断 + 前提变更作废（Phase 4，2026-11-06）。

背景：admin 目录第 1 章跑出 27 轮 rewrite、22 个 prealign 备份、38 个审计文件，
细纲被反复改写而下游正文/追踪承诺未同步，产生「500 份红油面」这类数值残留。
本脚本只做两件确定性的事：
  1. rewrite 轮数 > 上限 → stop_and_report（不再自动续一轮）；
  2. 细纲 outline_hash 变化时，把旧回执/快照/承诺标为 stale（不删文件，留痕）。
零 LLM、零网络；供 pipeline 在每次 rewrite 前与 pre_write 时调用，也可 CLI 自检。

用法：
  python3 nww_rewrite_fuse.py --book <dir> --chapter 1 --check
  python3 nww_rewrite_fuse.py --book <dir> --chapter 1 --sync-hash <md5>
  python3 nww_rewrite_fuse.py --book <dir> --chapter 1 --init-baseline

2026-11-07 口径修正（C-FUSE@1 上线次日，只增不改 + env 可回滚）：
  · 计数只算 rewrite 回执（对齐 docstring 的「重写轮数」），polish/write 失败不再顶数；
    NWW_REWRITE_FUSE_ALL_MODES=1 回滚到 11-06 原始口径。
  · receipts_at_last_sync 从「只写不读」改为参与 check：
    effective = max(0, 总数 - 基线)。基线由 --init-baseline（上线存量一次性豁免）
    或 sync_hash（成功提交后自动清零）登记；NWW_REWRITE_FUSE_BASELINE=0 回滚。
  · 基线必须显式登记，绝不在 check 里隐式登记——否则每次进程重启/新章首跑都会
    把已有失败清零，熔断形同虚设。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

FUSE_FILE = "追踪/rewrite_fuse.json"
DEFAULT_MAX = 3
RECEIPT_DIR = "追踪/执行回执"
RECEIPT_RE = re.compile(r"^第(\d{3})章_(rewrite|polish|write)_\d{8}_\d{6}\.json$")
# 2026-11-07：熔断语义是「重写轮数」，只数 rewrite 失败回执。
REWRITE_RE = re.compile(r"^第(\d{3})章_rewrite_\d{8}_\d{6}\.json$")


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def outline_hash(book: Path, chapter: int) -> str:
    """与 packet builder 的 meta.outline_hash 同口径：优先新案，回落存量。"""
    candidates = [
        book / "大纲" / "新案_黄金三章" / f"细纲_第{chapter:03d}章.md",
        book / "大纲" / f"细纲_第{chapter:03d}章.md",
    ]
    for p in candidates:
        if p.is_file():
            raw = p.read_text(encoding="utf-8", errors="ignore")
            return hashlib.md5(_norm(raw).encode("utf-8")).hexdigest()
    return ""


def _load(book: Path) -> dict:
    f = book / FUSE_FILE
    if not f.is_file():
        return {}
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save(book: Path, data: dict) -> None:
    f = book / FUSE_FILE
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _all_modes() -> bool:
    """env 回滚：=1 恢复 11-06 口径（rewrite + polish + write 全数）。"""
    return os.environ.get("NWW_REWRITE_FUSE_ALL_MODES", "0") == "1"


def _baseline_enabled() -> bool:
    """env 回滚：=0 关闭基线减法，回到「数全部历史回执」。"""
    return os.environ.get("NWW_REWRITE_FUSE_BASELINE", "1") != "0"


def _count_blocked_enabled() -> bool:
    """env 回滚：=1 恢复旧行为（被 fuse 拦截的尝试也计入重写轮数）。"""
    return os.environ.get("NWW_FUSE_COUNT_BLOCKED", "0") == "1"


def _receipt_counted(path: Path) -> bool:
    """判断单份回执是否代表一轮真实重写。

    历史回执没有 counted 字段 → 计入；counted is False（fuse 前置闸当场拒绝，
    正文一个字未动）→ 不计；解析失败 → 保守计入（防借损坏文件绕过熔断）。
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return True  # 解析失败按计入（保守，防借损坏文件绕过熔断）
    if not isinstance(data, dict):
        return True
    return data.get("counted") is not False


def count_receipts(book: Path, chapter: int) -> int:
    d = book / RECEIPT_DIR
    if not d.is_dir():
        return 0
    pat = RECEIPT_RE if _all_modes() else REWRITE_RE
    total = 0
    for p in d.iterdir():
        m = pat.match(p.name)
        if not m or int(m.group(1)) != chapter:
            continue
        # 2026-11-07：被 fuse 前置闸拦截、正文未重新生成的尝试只留痕，不计轮数。
        if not _count_blocked_enabled() and not _receipt_counted(p):
            continue
        total += 1
    return total


def effective_receipts(book: Path, chapter: int, rec: dict) -> dict:
    """返回 {"total", "baseline", "effective"}。

    baseline = receipts_at_last_sync（上线基线 / 最近一次成功提交时的计数）。
    人工裁剪过回执时 total 可能小于 baseline，钳到 [0, total] 防负数。
    """
    total = count_receipts(book, chapter)
    raw = int((rec or {}).get("receipts_at_last_sync") or 0) if _baseline_enabled() else 0
    base = max(0, min(raw, total))
    return {"total": total, "baseline": base, "effective": total - base}


def init_baseline(book: Path, chapter: int) -> dict:
    """一次性登记「上线前存量」基线。只写 fuse 状态文件，绝不删改任何执行回执。"""
    data = _load(book)
    key = str(chapter)
    rec = dict(data.get(key) or {})
    total = count_receipts(book, chapter)
    prev = rec.get("receipts_at_last_sync")
    rec["receipts_at_last_sync"] = total
    rec["baseline_source"] = "legacy_upgrade"
    data[key] = rec
    _save(book, data)
    return {"ok": True, "action": "baseline_initialized", "chapter": chapter,
            "receipts_total": total, "previous_baseline": prev,
            "effective": 0,
            "note": "仅登记基线，未删除/修改任何执行回执；后续成功提交会自动重设基线"}


def check(book: Path, chapter: int, max_rewrites: int = DEFAULT_MAX) -> dict:
    """返回 {"ok": bool, "action": str, "reason": str, ...}。"""
    data = _load(book)
    key = str(chapter)
    rec = data.get(key) or {}
    cur_hash = outline_hash(book, chapter)
    counts = effective_receipts(book, chapter, rec)
    result = {"ok": True, "action": "pass", "chapter": chapter,
              "outline_hash": cur_hash, "receipts": counts["effective"],
              "receipts_total": counts["total"], "baseline": counts["baseline"],
              "max_rewrites": max_rewrites}
    if cur_hash and rec.get("outline_hash") and rec["outline_hash"] != cur_hash:
        result.update({
            "ok": False, "action": "stop_and_report",
            "reason": (f"前提已变更：细纲 outline_hash {rec['outline_hash'][:8]} → {cur_hash[:8]}。"
                       f"旧回执/快照/追踪承诺须一次性作废旧值，不得在新细纲上续写旧正文。"),
        })
        return result
    if result["receipts"] > max_rewrites:
        _exempt = (f"，已按上线/提交基线豁免 {result['baseline']} 份"
                   if result["baseline"] else "")
        result.update({
            "ok": False, "action": "stop_and_report",
            "reason": (f"第 {chapter} 章新一轮已有 {result['receipts']} 份执行回执 > 上限 {max_rewrites}"
                       f"（历史存量 {result['receipts_total']} 份{_exempt}）。"
                       f"停止自动重写，转人工复核模具（不靠再改一轮正文硬凑）。"),
        })
        return result
    return result


def sync_hash(book: Path, chapter: int, new_hash: str = "") -> dict:
    """pre_write / finalize 成功后登记当前细纲 hash，作为下一轮的前提基线。

    receipts_at_last_sync 同时是熔断计数基线：提交成功即把之前的失败清零，
    新的一轮重新享有 max_rewrites 次重写额度（2026-11-07 起 check 会消费它）。
    """
    data = _load(book)
    key = str(chapter)
    h = new_hash or outline_hash(book, chapter)
    rec = dict(data.get(key) or {})
    prev = rec.get("outline_hash")
    # 保留 baseline_source 等审计键，不整条覆盖（2026-11-07）
    rec.update({"outline_hash": h,
                "stale_from": ([prev] if prev and prev != h else []),
                "receipts_at_last_sync": count_receipts(book, chapter)})
    data[key] = rec
    _save(book, data)
    return {"ok": True, "action": "synced", "chapter": chapter,
            "outline_hash": h, "invalidated_previous": bool(prev and prev != h)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--book", required=True)
    ap.add_argument("--chapter", type=int, required=True)
    ap.add_argument("--max-rewrites", type=int, default=DEFAULT_MAX)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--sync-hash", default=None, nargs="?", const="")
    ap.add_argument("--init-baseline", action="store_true",
                    help="一次性登记上线存量基线（只写 fuse 状态，不删回执）")
    args = ap.parse_args()
    book = Path(args.book)
    if args.init_baseline:
        out = init_baseline(book, args.chapter)
    elif args.sync_hash is not None:
        out = sync_hash(book, args.chapter, args.sync_hash)
    else:
        out = check(book, args.chapter, args.max_rewrites)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
