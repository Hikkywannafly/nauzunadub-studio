"""Timeline rebalance — đổi start/end của các segment sao cho chars-per-second
(CPS) đều xuyên suốt video, để giọng TTS không bị "gấp" ở các seg text dài.

Hai mode:

* **Even (algorithmic)**: gom segment thành các *run* liên tiếp (không cách
  nhau khoảng lặng); trong mỗi run, phân lại thời lượng theo trọng số ký tự.
  Tổng thời lượng từng run KHÔNG đổi → không phá lip-sync ở chỗ pause natural.
  Per-seg drift cap để tránh boundary nhảy quá xa vị trí gốc.

* **AI (LLM-assisted)**: gửi list segments cho LLM, yêu cầu propose new
  start/end ở dạng JSON. Validate strict (giữ order, không out-of-bounds, không
  overlap, không vượt video duration). Fallback về Even nếu LLM trả invalid.

Pure functions — không touch I/O. Router gọi snapshot + save vào job.
"""
from __future__ import annotations

import json
import logging
from typing import Iterable, Optional

from services.speech_rate import _RATE_CPS
from services.llm_backend import get_active_llm_backend, OffBackend

logger = logging.getLogger("omnivoice.timeline_rebalance")

# ── Tunables ──────────────────────────────────────────────────────────────
_GAP_EPSILON_S = 0.01      # ≤ 10ms → coi 2 seg là liền nhau (cùng run)
_MIN_SLOT_S = 0.40         # seg ngắn nhất sau rebalance, tránh stretch quá tay
_DEFAULT_MAX_DRIFT_S = 1.50  # cap shift boundary khỏi vị trí gốc, giữ lip-sync


def _seg_chars(seg: dict) -> int:
    """Trọng số ký tự — clamp ≥1 để seg rỗng không nhận 0s."""
    return max(1, len((seg.get("text") or "").strip()))


def _seg_start(seg: dict) -> float:
    return float(seg.get("start") or 0.0)


def _seg_end(seg: dict) -> float:
    return float(seg.get("end") or 0.0)


def _cluster_runs(segs: list[dict]) -> list[list[int]]:
    """Chia segments thành các run liên tiếp (gap ≤ epsilon)."""
    if not segs:
        return []
    runs: list[list[int]] = []
    cur: list[int] = [0]
    for i in range(1, len(segs)):
        if _seg_start(segs[i]) - _seg_end(segs[i - 1]) > _GAP_EPSILON_S:
            runs.append(cur)
            cur = [i]
        else:
            cur.append(i)
    runs.append(cur)
    return runs


def rebalance_even(
    segs: list[dict],
    *,
    max_drift_s: float = _DEFAULT_MAX_DRIFT_S,
) -> tuple[list[dict], dict]:
    """Algorithmic rebalance — trả (new_segs, stats).

    Logic:
      1. Cluster segments thành runs (chuỗi liền nhau, không cách bằng gap).
      2. Trong mỗi run, phân lại boundary theo tỷ lệ char count.
      3. Per-seg drift cap ±max_drift_s so với boundary gốc.
      4. Run đầu/cuối giữ nguyên start/end ngoài cùng → không phá overall sync.
    """
    if not segs:
        return [], {"runs": 0, "shifted": 0, "max_drift_s": 0.0}

    new_segs = [dict(s) for s in segs]
    runs = _cluster_runs(segs)
    total_shifted = 0
    max_observed_drift = 0.0

    for run in runs:
        if len(run) <= 1:
            continue  # 1-seg run không cần phân lại
        run_start = _seg_start(segs[run[0]])
        run_end = _seg_end(segs[run[-1]])
        run_duration = run_end - run_start
        if run_duration <= 0:
            continue

        chars = [_seg_chars(segs[i]) for i in run]
        total_chars = sum(chars)
        if total_chars <= 0:
            continue

        cursor = run_start
        for k, idx in enumerate(run):
            if k == len(run) - 1:
                # Anchor seg cuối run vào run_end để không tích lũy float drift
                new_segs[idx]["start"] = round(cursor, 3)
                new_segs[idx]["end"] = round(run_end, 3)
                drift = abs(_seg_end(segs[idx]) - run_end)
                if drift > 1e-3:
                    total_shifted += 1
                    max_observed_drift = max(max_observed_drift, drift)
                continue

            ideal_duration = run_duration * (chars[k] / total_chars)
            ideal_duration = max(_MIN_SLOT_S, ideal_duration)
            proposed_end = cursor + ideal_duration

            # Cap drift so với end gốc của seg này
            orig_end = _seg_end(segs[idx])
            proposed_end = max(orig_end - max_drift_s, min(orig_end + max_drift_s, proposed_end))
            # Không vượt run_end (an toàn float)
            proposed_end = min(proposed_end, run_end - _MIN_SLOT_S * (len(run) - k - 1))

            new_segs[idx]["start"] = round(cursor, 3)
            new_segs[idx]["end"] = round(proposed_end, 3)
            if abs(orig_end - proposed_end) > 1e-3 or abs(_seg_start(segs[idx]) - cursor) > 1e-3:
                total_shifted += 1
                max_observed_drift = max(max_observed_drift, abs(orig_end - proposed_end))
            cursor = proposed_end

    stats = {
        "runs": len(runs),
        "shifted": total_shifted,
        "max_drift_s": round(max_observed_drift, 3),
        "total_segs": len(segs),
    }
    return new_segs, stats


# ── AI mode ───────────────────────────────────────────────────────────────

_AI_SYSTEM_PROMPT = """\
You are a dubbing editor. Your job is to re-time segment boundaries so the
dubbing voice reads each line at a comfortable, even pace — never rushed,
never with awkward gaps mid-sentence.

You will be given a JSON array of segments. Each has: id, start, end, text.
Return ONLY valid JSON in the same shape, with new `start` and `end` values.

Hard rules — violating any one is a failed response:
1. Same number of items, same `id`s, same order.
2. Each segment: 0 ≤ start < end.
3. No segment may overlap the next: end_i ≤ start_{i+1}.
4. First segment's start and last segment's end MUST stay identical to the input.
5. Boundary shift from input: keep within ±1.5 seconds where possible.

Soft preferences (in order):
A. Even chars-per-second across segments.
B. Preserve natural pauses (large gaps between segments stay as gaps).
C. Avoid moving boundaries that already sit at a natural sentence break.

Output: just the JSON array. No prose, no markdown fence."""


def _validate_ai_output(proposed: list[dict], original: list[dict]) -> Optional[list[dict]]:
    """Strict validation. Reject any violation → caller falls back to Even.

    Returns the validated proposal merged onto originals (preserving non-timing
    fields like text), or None when invalid.
    """
    if not isinstance(proposed, list) or len(proposed) != len(original):
        logger.warning("AI rebalance: wrong length (%s vs %s)", len(proposed), len(original))
        return None

    out: list[dict] = []
    prev_end: float | None = None
    for i, (p, o) in enumerate(zip(proposed, original)):
        if not isinstance(p, dict):
            return None
        if str(p.get("id")) != str(o.get("id")):
            logger.warning("AI rebalance: id mismatch at %d (%r vs %r)", i, p.get("id"), o.get("id"))
            return None
        try:
            new_start = float(p["start"])
            new_end = float(p["end"])
        except (KeyError, TypeError, ValueError):
            return None
        if new_start < 0 or new_end <= new_start:
            return None
        if prev_end is not None and new_start + 1e-3 < prev_end:
            logger.warning("AI rebalance: overlap at %d (%.3f < prev %.3f)", i, new_start, prev_end)
            return None
        # First/last anchor preserved
        if i == 0 and abs(new_start - _seg_start(o)) > 1e-2:
            logger.warning("AI rebalance: first start drifted (%.3f vs %.3f)", new_start, _seg_start(o))
            return None
        if i == len(original) - 1 and abs(new_end - _seg_end(o)) > 1e-2:
            logger.warning("AI rebalance: last end drifted (%.3f vs %.3f)", new_end, _seg_end(o))
            return None
        merged = dict(o)
        merged["start"] = round(new_start, 3)
        merged["end"] = round(new_end, 3)
        out.append(merged)
        prev_end = new_end
    return out


def rebalance_ai(segs: list[dict]) -> tuple[list[dict], dict]:
    """LLM-assisted rebalance. Falls back to Even if LLM unavailable or output
    invalid. Stats include `mode: "ai" | "ai-fallback-even"`.
    """
    if not segs:
        return [], {"runs": 0, "shifted": 0, "max_drift_s": 0.0, "mode": "ai"}

    llm = get_active_llm_backend()
    if isinstance(llm, OffBackend):
        new_segs, stats = rebalance_even(segs)
        stats["mode"] = "ai-fallback-even"
        stats["fallback_reason"] = "no-llm-configured"
        return new_segs, stats

    payload = [
        {"id": str(s.get("id", i)), "start": round(_seg_start(s), 3),
         "end": round(_seg_end(s), 3), "text": (s.get("text") or "")}
        for i, s in enumerate(segs)
    ]
    user_msg = json.dumps(payload, ensure_ascii=False)

    try:
        raw = llm.chat(system=_AI_SYSTEM_PROMPT, user=user_msg)
    except Exception as e:
        logger.warning("AI rebalance LLM call failed: %s — falling back to even", e)
        new_segs, stats = rebalance_even(segs)
        stats["mode"] = "ai-fallback-even"
        stats["fallback_reason"] = f"llm-error: {e}"
        return new_segs, stats

    # LLM đôi khi vẫn quấn markdown — strip ```json fence nếu có
    raw_clean = (raw or "").strip()
    if raw_clean.startswith("```"):
        raw_clean = raw_clean.strip("`")
        if raw_clean.lower().startswith("json"):
            raw_clean = raw_clean[4:].strip()

    try:
        proposed = json.loads(raw_clean)
    except json.JSONDecodeError:
        logger.warning("AI rebalance: LLM returned non-JSON — falling back")
        new_segs, stats = rebalance_even(segs)
        stats["mode"] = "ai-fallback-even"
        stats["fallback_reason"] = "invalid-json"
        return new_segs, stats

    validated = _validate_ai_output(proposed, segs)
    if validated is None:
        new_segs, stats = rebalance_even(segs)
        stats["mode"] = "ai-fallback-even"
        stats["fallback_reason"] = "validation-failed"
        return new_segs, stats

    # Compute stats
    total_shifted = sum(
        1 for orig, new in zip(segs, validated)
        if abs(_seg_start(orig) - _seg_start(new)) > 1e-3 or abs(_seg_end(orig) - _seg_end(new)) > 1e-3
    )
    max_drift = max(
        (max(abs(_seg_start(orig) - _seg_start(new)), abs(_seg_end(orig) - _seg_end(new)))
         for orig, new in zip(segs, validated)),
        default=0.0,
    )
    return validated, {
        "mode": "ai",
        "runs": len(_cluster_runs(segs)),
        "shifted": total_shifted,
        "max_drift_s": round(max_drift, 3),
        "total_segs": len(segs),
    }


def cps_summary(segs: Iterable[dict], lang: str = "en") -> dict:
    """Quick stat — mean / max CPS để frontend show "improvement: X% → Y%"."""
    target_cps = _RATE_CPS.get((lang or "en").split("-")[0].lower(), 13.0)
    items = list(segs)
    if not items:
        return {"mean_cps": 0.0, "max_cps": 0.0, "target_cps": target_cps, "over_count": 0}
    ratios = []
    for s in items:
        dur = max(0.01, _seg_end(s) - _seg_start(s))
        cps = _seg_chars(s) / dur
        ratios.append(cps)
    over = sum(1 for r in ratios if r > target_cps * 1.15)
    return {
        "mean_cps": round(sum(ratios) / len(ratios), 2),
        "max_cps": round(max(ratios), 2),
        "target_cps": round(target_cps, 2),
        "over_count": over,
    }
