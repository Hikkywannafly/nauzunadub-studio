"""Voice Settings API — per-speaker voice assignment + per-segment regenerate.

After Transcribe + Translate finishes, each segment carries a ``speaker_id``
(``Speaker 1``, ``Speaker 2``, …). This router lets the UI assign one voice
profile + engine + DSP params per speaker, preview a sample utterance, and
re-run TTS on a single segment without redoing the whole job.

Tables touched:
    speaker_voice_assignments(job_id, speaker_id, profile_id, engine, pitch, speed, volume, updated_at)

All endpoints are mounted under ``/api/dub/{job_id}/...``.
"""
from __future__ import annotations

import io
import os
import time
import uuid
import logging
from typing import Optional, List

import soundfile as sf
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

from core.db import db_conn
from core.config import DUB_DIR, PREVIEW_DIR
from services import dub_pipeline

logger = logging.getLogger("videodub.dub_voices")
router = APIRouter(prefix="/api/dub", tags=["dub-voices"])


# ── Schemas ────────────────────────────────────────────────────────────────


class SpeakerInfo(BaseModel):
    speaker_id: str
    segment_count: int
    total_duration: float
    sample_text: str
    first_start: float
    profile_id: Optional[str] = None
    engine: Optional[str] = None
    pitch: float = 0.0
    speed: float = 1.0
    volume: float = 1.0


class SpeakerAssignment(BaseModel):
    profile_id: Optional[str] = None
    engine: Optional[str] = None
    pitch: Optional[float] = None  # semitones, -12 … +12
    speed: Optional[float] = None  # 0.5 … 2.0
    volume: Optional[float] = None  # 0.0 … 2.0


class PreviewRequest(BaseModel):
    speaker_id: str
    text: Optional[str] = None  # if missing, use the first segment text of that speaker


class RegenerateRequest(BaseModel):
    text: Optional[str] = None  # if provided, overrides the segment text for this regen


# ── Helpers ────────────────────────────────────────────────────────────────


def _load_assignments(job_id: str) -> dict[str, dict]:
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT speaker_id, profile_id, engine, pitch, speed, volume "
            "FROM speaker_voice_assignments WHERE job_id = ?",
            (job_id,),
        ).fetchall()
    return {r["speaker_id"]: dict(r) for r in rows}


def _upsert_assignment(job_id: str, speaker_id: str, body: SpeakerAssignment) -> dict:
    existing = _load_assignments(job_id).get(speaker_id) or {}
    merged = {
        "profile_id": body.profile_id if body.profile_id is not None else existing.get("profile_id"),
        "engine": body.engine if body.engine is not None else existing.get("engine", ""),
        "pitch": body.pitch if body.pitch is not None else existing.get("pitch", 0.0),
        "speed": body.speed if body.speed is not None else existing.get("speed", 1.0),
        "volume": body.volume if body.volume is not None else existing.get("volume", 1.0),
    }
    with db_conn() as conn:
        conn.execute(
            """INSERT INTO speaker_voice_assignments
               (job_id, speaker_id, profile_id, engine, pitch, speed, volume, updated_at)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(job_id, speaker_id) DO UPDATE SET
                 profile_id=excluded.profile_id,
                 engine=excluded.engine,
                 pitch=excluded.pitch,
                 speed=excluded.speed,
                 volume=excluded.volume,
                 updated_at=excluded.updated_at""",
            (
                job_id, speaker_id,
                merged["profile_id"], merged["engine"] or "",
                float(merged["pitch"] or 0.0),
                float(merged["speed"] or 1.0),
                float(merged["volume"] or 1.0),
                time.time(),
            ),
        )
    return merged


def apply_assignments_to_segments(job_id: str, segments: List[dict]) -> List[dict]:
    """Mutate segments in-place: copy speaker-level voice config into each segment.

    Used by ``dub_generate`` to honor the Voice Settings UI without changing
    the existing per-segment generate contract. Per-segment overrides set by
    the user on the segment itself still win.
    """
    assignments = _load_assignments(job_id)
    if not assignments:
        return segments
    for seg in segments:
        spk = seg.get("speaker_id")
        if not spk or spk not in assignments:
            continue
        a = assignments[spk]
        if not seg.get("profile_id") and a.get("profile_id"):
            seg["profile_id"] = a["profile_id"]
        if not seg.get("engine") and a.get("engine"):
            seg["engine"] = a["engine"]
        # speed: segment-level wins if non-default
        if (seg.get("speed") is None or seg.get("speed") == 1.0) and a.get("speed"):
            seg["speed"] = float(a["speed"])
        if (seg.get("gain") is None or seg.get("gain") == 1.0) and a.get("volume"):
            seg["gain"] = float(a["volume"])
        if a.get("pitch") and not seg.get("pitch"):
            seg["pitch"] = float(a["pitch"])
    return segments


# ── Endpoints ──────────────────────────────────────────────────────────────


@router.get("/{job_id}/speakers", response_model=List[SpeakerInfo])
def list_speakers(job_id: str) -> List[SpeakerInfo]:
    job = dub_pipeline.get_job(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    segments = job.get("segments") or []
    if not segments:
        return []
    assignments = _load_assignments(job_id)
    buckets: dict[str, dict] = {}
    for s in segments:
        spk = s.get("speaker_id") or "Speaker 1"
        b = buckets.setdefault(spk, {
            "speaker_id": spk,
            "segment_count": 0,
            "total_duration": 0.0,
            "sample_text": "",
            "first_start": float("inf"),
        })
        b["segment_count"] += 1
        start = float(s.get("start", 0.0))
        end = float(s.get("end", 0.0))
        b["total_duration"] += max(0.0, end - start)
        if start < b["first_start"]:
            b["first_start"] = start
            b["sample_text"] = (s.get("text") or "")[:120]
    out: List[SpeakerInfo] = []
    for spk, b in sorted(buckets.items(), key=lambda kv: kv[1]["first_start"]):
        a = assignments.get(spk, {})
        out.append(SpeakerInfo(
            speaker_id=spk,
            segment_count=b["segment_count"],
            total_duration=round(b["total_duration"], 2),
            sample_text=b["sample_text"],
            first_start=b["first_start"] if b["first_start"] != float("inf") else 0.0,
            profile_id=a.get("profile_id"),
            engine=a.get("engine") or None,
            pitch=float(a.get("pitch") or 0.0),
            speed=float(a.get("speed") or 1.0),
            volume=float(a.get("volume") or 1.0),
        ))
    return out


@router.put("/{job_id}/speakers/{speaker_id}")
def set_speaker_assignment(job_id: str, speaker_id: str, body: SpeakerAssignment) -> dict:
    job = dub_pipeline.get_job(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    if not any((s.get("speaker_id") or "Speaker 1") == speaker_id for s in (job.get("segments") or [])):
        raise HTTPException(404, f"speaker_id {speaker_id!r} not present in job {job_id}")
    merged = _upsert_assignment(job_id, speaker_id, body)
    return {"speaker_id": speaker_id, **merged}


@router.delete("/{job_id}/speakers/{speaker_id}")
def clear_speaker_assignment(job_id: str, speaker_id: str) -> dict:
    with db_conn() as conn:
        conn.execute(
            "DELETE FROM speaker_voice_assignments WHERE job_id = ? AND speaker_id = ?",
            (job_id, speaker_id),
        )
    return {"ok": True}


@router.post("/{job_id}/preview-voice")
def preview_voice(job_id: str, body: PreviewRequest):
    """Render a single utterance with the speaker's current voice config so the
    user can audition the choice before re-running the full Generate step.
    """
    job = dub_pipeline.get_job(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    segments = job.get("segments") or []
    text = body.text or ""
    if not text:
        for s in segments:
            if (s.get("speaker_id") or "Speaker 1") == body.speaker_id:
                text = s.get("text", "")
                break
    if not text:
        raise HTTPException(400, "No text supplied and no segment found for speaker")

    a = _load_assignments(job_id).get(body.speaker_id, {})
    profile_id = a.get("profile_id") or ""
    if not profile_id:
        raise HTTPException(400, f"Speaker {body.speaker_id!r} has no voice profile assigned")

    # Load profile reference audio + invoke TTS backend
    from services import tts_backend, speaker_clone
    with db_conn() as conn:
        prof = conn.execute(
            "SELECT id, ref_audio_path, ref_text, instruct, language FROM voice_profiles WHERE id = ?",
            (profile_id,),
        ).fetchone()
    if not prof:
        raise HTTPException(404, f"Voice profile {profile_id} missing on disk")

    engine_id = a.get("engine") or None
    backend = tts_backend.get_backend_class(engine_id)() if engine_id else tts_backend.get_active_tts_backend()

    speed = float(a.get("speed") or 1.0)
    try:
        wav = backend.generate(
            text=text,
            ref_audio_path=prof["ref_audio_path"],
            ref_text=prof["ref_text"] or "",
            instruct=prof["instruct"] or "",
            language=prof["language"] or "Auto",
            speed=speed,
        )
    except TypeError:
        # Older TTS backends only accept (text, ref_audio_path); be forgiving.
        wav = backend.generate(text=text, ref_audio_path=prof["ref_audio_path"])

    sr = getattr(backend, "sample_rate", 24000)
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    out_name = f"voice_preview_{uuid.uuid4().hex[:8]}.wav"
    out_path = os.path.join(PREVIEW_DIR, out_name)
    sf.write(out_path, wav, sr)
    return JSONResponse({
        "preview_url": f"/audio/../preview/{out_name}",
        "filename": out_name,
        "sample_rate": sr,
        "duration": float(len(wav)) / float(sr),
    })


@router.post("/{job_id}/segments/{seg_id}/regenerate")
def regenerate_segment(job_id: str, seg_id: str, body: RegenerateRequest):
    """Re-run TTS on a single segment with the current voice assignment.

    Writes ``seg_<seg_id>.wav`` into the job's working dir so the next Export
    step picks it up. The full Generate step is *not* re-triggered.
    """
    job = dub_pipeline.get_job(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    segments = list(job.get("segments") or [])
    seg = next((s for s in segments if str(s.get("id", "")) == seg_id), None)
    if seg is None:
        raise HTTPException(404, f"Segment {seg_id} not found in job {job_id}")

    text = body.text if body.text is not None else seg.get("text") or ""
    if not text.strip():
        raise HTTPException(400, "Segment text is empty")

    apply_assignments_to_segments(job_id, [seg])
    profile_id = seg.get("profile_id") or ""
    if not profile_id:
        raise HTTPException(
            400,
            f"Segment {seg_id} has no voice profile (assign one via PUT /api/dub/{job_id}/speakers/{seg.get('speaker_id')})",
        )

    from services import tts_backend
    with db_conn() as conn:
        prof = conn.execute(
            "SELECT id, ref_audio_path, ref_text, instruct, language FROM voice_profiles WHERE id = ?",
            (profile_id,),
        ).fetchone()
    if not prof:
        raise HTTPException(404, f"Voice profile {profile_id} missing")

    backend = tts_backend.get_backend_class(seg.get("engine"))() if seg.get("engine") else tts_backend.get_active_tts_backend()
    try:
        wav = backend.generate(
            text=text,
            ref_audio_path=prof["ref_audio_path"],
            ref_text=prof["ref_text"] or "",
            instruct=prof["instruct"] or "",
            language=prof["language"] or "Auto",
            speed=float(seg.get("speed") or 1.0),
        )
    except TypeError:
        wav = backend.generate(text=text, ref_audio_path=prof["ref_audio_path"])

    job_dir = dub_pipeline.safe_job_dir(job_id)
    if not job_dir:
        raise HTTPException(400, "Job directory missing or unsafe")
    out_path = os.path.join(job_dir, f"seg_{seg_id}.wav")
    sf.write(out_path, wav, getattr(backend, "sample_rate", 24000))

    # Persist updated segment text if the user edited it.
    if body.text is not None:
        for s in segments:
            if str(s.get("id", "")) == seg_id:
                s["text"] = body.text
                break
        job["segments"] = segments
        dub_pipeline.save_job(job_id, job)

    return {
        "segment_id": seg_id,
        "filename": f"seg_{seg_id}.wav",
        "duration": float(len(wav)) / float(getattr(backend, "sample_rate", 24000)),
    }
