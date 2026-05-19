import os
import json
import logging
import time
import asyncio
import torch
import torchaudio
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from core.db import db_conn
from core.config import DUB_DIR, VOICES_DIR
from core.tasks import task_manager
from schemas.requests import DubRequest
from services.model_manager import get_model, _gpu_pool
from services.audio_dsp import apply_mastering, normalize_audio
from services.rvc import apply_rvc, is_enabled as rvc_is_enabled
from services.incremental import segment_fingerprint
from services.watermark import embed_watermark
from api.routers.dub_core import _get_job, _save_job

logger = logging.getLogger("omnivoice.dub")

router = APIRouter()

# Mix-time fitting constants. Tuned for natural-sounding ends-of-sentences:
#   * Old behaviour hard-trimmed audio to the slot and applied a 15ms fade,
#     which clipped the natural breath/tail on the end of every line.
#   * `_END_FADE_MS = 50` lets the tail decay smoothly — still inaudible if
#     audio is well below slot end (we trim the silence first via fade math),
#     audibly softer if we *do* hit a boundary.
#   * `_TAIL_ALLOWANCE_S = 0.25` lets a segment bleed up to 250ms past its
#     nominal end ONLY into the gap before the next segment. This keeps the
#     soft tail of one line from being amputated when the source had room for
#     it, while still preventing overlap with the next speaker.
_END_FADE_MS = 50
_START_FADE_MS = 15  # leading fade stays short — TTS starts cleanly
_TAIL_ALLOWANCE_S = 0.25


@router.get("/api/audio-profiles")
async def list_audio_profiles_endpoint():
    """Danh sách audio post-processing profile (cinematic/broadcast/voiceover/natural)
    — consumed bởi `audio_profile` field trong DubRequest dưới đây.
    """
    from services.audio_dsp import list_audio_profiles
    return {"profiles": list_audio_profiles()}


@router.post("/dub/generate/{job_id}")
async def dub_generate(job_id: str, req: DubRequest):
    """Adds a dub generation job to the async batch task pool."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(
            status_code=404,
            detail="This dub session has expired or was never created. Re-upload the video to start a new one.",
        )

    _model = await get_model()

    # Cảnh báo nếu user bấm Generate Dub mà CHƯA bấm Translate. Khi đó
    # frontend gửi text gốc (Trung/Anh) lên — TTS sẽ re-voice text gốc bằng
    # giọng cloned, output nghe gần giống video gốc, user tưởng "không dub".
    try:
        stored_segs = job.get("segments") or []
        n_untranslated = 0
        for i, seg in enumerate(req.segments):
            if i >= len(stored_segs):
                break
            orig = (stored_segs[i].get("text_original") or stored_segs[i].get("text") or "").strip()
            cur = (getattr(seg, "text", "") or "").strip()
            if orig and cur and orig == cur:
                n_untranslated += 1
        if n_untranslated and n_untranslated == len(req.segments) and req.language_code and req.language_code != (job.get("source_lang") or ""):
            logger.warning(
                "Job %s: ALL %d segments still hold original text but target lang is '%s'. "
                "User likely skipped Translate — TTS will re-voice original text, output won't be %s.",
                job_id, n_untranslated, req.language_code, req.language_code,
            )
    except Exception:
        pass

    # Voice Settings overlay — populate profile_id/speed/gain on segments
    # whose speaker has a stored assignment, unless the request already
    # set them. Index-based join with the job's stored segments (which
    # carry the canonical speaker_id from the diarization step).
    try:
        from api.routers.dub_voices import _load_assignments
        assignments = _load_assignments(job_id)
        stored = job.get("segments") or []
        if assignments and stored:
            for i, seg in enumerate(req.segments):
                if i >= len(stored):
                    break
                spk = stored[i].get("speaker_id") or "Speaker 1"
                a = assignments.get(spk)
                if not a:
                    continue
                if not seg.profile_id and a.get("profile_id"):
                    seg.profile_id = a["profile_id"]
                if (seg.speed is None or seg.speed == 1.0) and a.get("speed"):
                    seg.speed = float(a["speed"])
                if (seg.gain is None or seg.gain == 1.0) and a.get("volume"):
                    seg.gain = float(a["volume"])
    except Exception as _voice_e:
        logger.warning("Voice Settings overlay skipped: %s", _voice_e)

    async def _stream(task_id):
        total = len(req.segments)
        all_segment_wavs = []
        sync_scores = []

        # Phase 4.1 — partial regen. If `regen_only` is set, we only run TTS
        # on segments whose id is in that set; the others reuse their existing
        # `seg_i.wav` on disk and slot into the final mix unchanged.
        regen_only = set(req.regen_only or []) if req.regen_only is not None else None
        seg_ids = req.segment_ids or []

        # Deferred disk writes: collect (index, tensor, sr, seg_id, fingerprint,
        # num_step) tuples during the hot loop and batch-flush after all TTS
        # completes. Eliminates ~200ms/seg of synchronous I/O from the GPU path.
        _pending_seg_writes: list[tuple] = []

        # Phase 4.1 bench instrumentation: measure where incremental time goes.
        # Only prints when regen_only is active (real-user incremental path).
        _t_start = time.perf_counter()
        _t_cache = 0.0
        _t_tts = 0.0

        for i, seg in enumerate(req.segments):
            seg_id = seg_ids[i] if i < len(seg_ids) else f"seg_{i}"

            # Check abort flag before each segment
            if task_manager.is_cancelled(task_id):
                yield f"data: {json.dumps({'type': 'cancelled', 'segments_processed': i})}\n\n"
                return

            yield f"data: {json.dumps({'type': 'progress', 'current': i, 'total': total, 'text': seg.text[:50]})}\n\n"

            seg_duration = seg.end - seg.start
            if seg_duration <= 0.05 or not seg.text.strip():
                sr = _model.sampling_rate
                silence = torch.zeros(1, int(seg_duration * sr))
                all_segment_wavs.append((seg.start, seg.end, silence, sr))
                sync_scores.append(1.0)
                continue

            # Partial regen: if this segment isn't in the allow-list, reuse its
            # previously-rendered WAV so the final mix still covers the timeline.
            if regen_only is not None and seg_id not in regen_only:
                seg_wav_path = os.path.join(DUB_DIR, job_id, f"seg_{i}.wav")
                if os.path.exists(seg_wav_path):
                    try:
                        _t_cache_0 = time.perf_counter()
                        cached_wav, cached_sr = torchaudio.load(seg_wav_path)
                        if cached_sr != _model.sampling_rate:
                            import torchaudio.functional as AF
                            cached_wav = AF.resample(cached_wav, cached_sr, _model.sampling_rate)
                        # Keep raw audio length — slot fitting + tail allowance
                        # are handled uniformly in the mix loop below.
                        all_segment_wavs.append((seg.start, seg.end, cached_wav, _model.sampling_rate))
                        sync_scores.append(getattr(seg, 'sync_ratio', None) or 1.0)
                        _t_cache += time.perf_counter() - _t_cache_0
                        continue
                    except Exception as e:
                        # Fall through to a silent placeholder if the cached WAV
                        # is broken — cleaner than aborting the whole mix.
                        yield f"data: {json.dumps({'type': 'warning', 'segment': i, 'message': f'cached seg lost, padding silence: {str(e)[:120]}'})}\n\n"
                sr = _model.sampling_rate
                silence = torch.zeros(1, int(seg_duration * sr))
                all_segment_wavs.append((seg.start, seg.end, silence, sr))
                sync_scores.append(1.0)
                continue

            def _gen(text, lang, instruct_str, nstep, cfg, spd, profile_id=None):
                ref_audio = None
                ref_text = None
                used_seed = None

                # Auto-clones extracted from the source video during prepare
                # (see services/speaker_clone.py) live at job["speaker_clones"]
                # keyed by speaker_id. We use the `auto:` prefix so they can't
                # collide with persistent voice_profiles.id values.
                if profile_id and profile_id.startswith("auto:"):
                    key = profile_id[len("auto:"):]
                    clones = job.get("speaker_clones") or {}
                    # Match by the safe-name key first, fall back to speaker_id.
                    auto = None
                    for spk, info in clones.items():
                        if spk.lower().replace(" ", "_") == key or spk == key:
                            auto = info
                            break
                    if auto:
                        ref_audio = auto.get("ref_audio")
                        ref_text = auto.get("ref_text")
                    profile_id = None  # prevent the voice_profiles lookup below

                if profile_id:
                    with db_conn() as conn:
                        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
                    if row:
                        if row["is_locked"] and row["locked_audio_path"]:
                            ref_audio = os.path.join(VOICES_DIR, row["locked_audio_path"])
                            ref_text = row["ref_text"]
                            used_seed = row["seed"]
                        elif row["instruct"] and not row["is_locked"]:
                            used_seed = row["seed"] 
                        else:
                            ref_audio = os.path.join(VOICES_DIR, row["ref_audio_path"])
                            ref_text = row["ref_text"]
                            used_seed = row["seed"]
                            
                        if not instruct_str:
                            instruct_str = row["instruct"]

                if used_seed is not None:
                    torch.manual_seed(used_seed)

                try:
                    # No `duration=` here — passing a fixed duration makes the
                    # model fill any leftover slot time with breath / "ah um"
                    # filler when the translated text is shorter than the source
                    # slot. We instead pre-compute `speed` from the text length
                    # vs slot ratio (see speed-fit block below) so the model
                    # picks its own natural duration close to the slot.
                    audios = _model.generate(
                        text=text, language=lang if lang != "Auto" else None,
                        ref_audio=ref_audio, ref_text=ref_text,
                        instruct=instruct_str if instruct_str else None,
                        num_step=nstep, guidance_scale=cfg,
                        speed=spd, denoise=True, postprocess_output=True,
                    )
                    audio_out = audios[0]
                    _ap = getattr(req, "audio_profile", None) or "broadcast"
                    mastered_audio = apply_mastering(
                        audio_out,
                        sample_rate=_model.sampling_rate if hasattr(_model, 'sampling_rate') else 24000,
                        profile=_ap,
                    )
                    return normalize_audio(mastered_audio, profile=_ap)
                except Exception as e:
                    is_oom = (
                        isinstance(e, torch.cuda.OutOfMemoryError)
                        or "out of memory" in str(e).lower()
                        or "CUDA error" in str(e)
                    )
                    import gc
                    gc.collect()
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                        torch.mps.empty_cache()

                    if not is_oom:
                        raise  # Non-OOM — propagate real error, don't mask it.

                    retry_steps = min(nstep, 8)
                    logger.warning(
                        "OOM on segment (nstep=%d), retrying with %d steps after cache flush",
                        nstep, retry_steps,
                    )
                    try:
                        audios = _model.generate(
                            text=text, language=lang if lang != "Auto" else None,
                            ref_audio=ref_audio, ref_text=ref_text,
                            instruct=instruct_str if instruct_str else None,
                            num_step=retry_steps, guidance_scale=cfg,
                            speed=spd, denoise=True, postprocess_output=True,
                        )
                        audio_out = audios[0]
                        _ap = getattr(req, "audio_profile", None) or "broadcast"
                        mastered_audio = apply_mastering(
                            audio_out,
                            sample_rate=_model.sampling_rate if hasattr(_model, 'sampling_rate') else 24000,
                            profile=_ap,
                        )
                        return normalize_audio(mastered_audio, profile=_ap)
                    except Exception as retry_err:
                        raise RuntimeError(
                            f"Ran out of GPU memory generating this segment. "
                            f"Retried with {retry_steps} steps but still failed. "
                            f"Try the Flush button in the header to free VRAM, "
                            f"or switch to CPU in Settings. "
                            f"Underlying error: {retry_err}"
                        )

            seg_instruct = seg.instruct or req.instruct
            seg_profile = seg.profile_id or None
            seg_speed = seg.speed if hasattr(seg, 'speed') and seg.speed is not None else req.speed
            seg_lang = seg.target_lang if getattr(seg, 'target_lang', None) else req.language

            # Speed-from-text-length: nudge `speed` so the model's natural
            # output lands close to the source slot, instead of passing
            # `duration=` and forcing it to pad with "ah um" filler. Clamp
            # ±15% — beyond that the speech sounds unnaturally rushed or
            # sluggish, and any remaining mismatch is better handled by
            # tail-allowance / time-stretch at mix time.
            try:
                from services.speech_rate import expected_duration
                lang_for_rate = req.language_code or "en"
                expected_s = expected_duration(seg.text, lang_for_rate)
                if seg_duration > 0 and expected_s > 0:
                    slot_factor = expected_s / seg_duration
                    slot_factor = max(0.85, min(1.25, slot_factor))
                    seg_speed = (seg_speed or 1.0) * slot_factor
            except Exception as _e:
                logger.debug("speed slot-fit skipped for %s: %s", seg_id, _e)

            # Phase 4.2 — if the segment carries a free-form direction, parse it
            # and append the taxonomy instruct (e.g. "urgent, surprised") on top
            # of whatever instruct was already set. Also apply the director's
            # speed bias so "urgent" actually sounds a bit quicker.
            seg_direction = getattr(seg, 'direction', None)
            if seg_direction and seg_direction.strip():
                try:
                    from services.director import parse as _parse_direction
                    d = _parse_direction(seg_direction)
                    extra_instruct = d.instruct_prompt()
                    if extra_instruct:
                        seg_instruct = (
                            f"{seg_instruct}, {extra_instruct}" if seg_instruct else extra_instruct
                        )
                    bias = d.rate_bias()
                    if bias and abs(bias - 1.0) > 0.01:
                        seg_speed = (seg_speed or 1.0) * bias
                except Exception as e:
                    logger.debug("direction parse skipped for %s: %s", getattr(seg, 'id', '?'), e)

            loop = asyncio.get_running_loop()
            try:
                # Fast-preview mode for interactive edits — trade ~10–20 %
                # quality for ~2× speed by dropping flow-matching steps.
                # Client sends `preview=true` when the user is iterating;
                # before final export the client should re-call without the
                # flag to restore num_step=req.num_step quality.
                _num_step = 8 if req.preview else req.num_step
                _t_tts_0 = time.perf_counter()
                audio_tensor = await loop.run_in_executor(
                    _gpu_pool, _gen,
                    seg.text, seg_lang, seg_instruct,
                    _num_step, req.guidance_scale, seg_speed, seg_profile,
                )
                _t_tts += time.perf_counter() - _t_tts_0

                # Check abort immediately after GPU work completes
                if task_manager.is_cancelled(task_id):
                    yield f"data: {json.dumps({'type': 'cancelled', 'segments_processed': i + 1})}\n\n"
                    return

                # Don't pad or hard-trim here. The mix loop below computes
                # per-segment tail allowance (how much the audio is allowed
                # to bleed into the gap before the next seg) and runs the
                # slot_fit logic uniformly for both fresh and cached audio.
                generated_dur = audio_tensor.shape[-1] / _model.sampling_rate
                sync_ratio = round(generated_dur / max(seg_duration, 0.01), 3)

                sync_scores.append(sync_ratio)

                # Build the fingerprint now (cheap) but defer the disk write
                # and job flush to the batch-write phase after the GPU loop.
                _seg_fp = None
                try:
                    _seg_fp = segment_fingerprint({
                        "text": seg.text,
                        "target_lang": getattr(seg, "target_lang", None),
                        "profile_id": getattr(seg, "profile_id", None),
                        "instruct": getattr(seg, "instruct", None),
                        "speed": getattr(seg, "speed", None),
                        "direction": getattr(seg, "direction", None),
                    })
                except Exception as e:
                    logger.debug("seg fingerprint skipped for %s: %s", seg_id, e)

                _pending_seg_writes.append((i, audio_tensor, _model.sampling_rate, seg_id, _seg_fp, _num_step))

                # RVC needs the WAV on disk, so write it immediately only
                # when RVC is active (uncommon path).
                if rvc_is_enabled():
                    seg_wav_path = os.path.join(DUB_DIR, job_id, f"seg_{i}.wav")
                    torchaudio.save(seg_wav_path, audio_tensor, _model.sampling_rate)
                    try:
                        await loop.run_in_executor(_gpu_pool, apply_rvc, seg_wav_path)
                        rvc_wav, rvc_sr = torchaudio.load(seg_wav_path)
                        if rvc_sr == _model.sampling_rate:
                            audio_tensor = rvc_wav
                    except Exception as e:
                        yield f"data: {json.dumps({'type': 'warning', 'segment': i, 'message': f'RVC skipped: {str(e)[:120]}'})}\n\n"

                all_segment_wavs.append((seg.start, seg.end, audio_tensor, _model.sampling_rate))
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'segment': i, 'error': str(e)})}\n\n"
                sr = _model.sampling_rate
                all_segment_wavs.append((seg.start, seg.end, torch.zeros(1, int(seg_duration * sr)), sr))
                sync_scores.append(1.0)

        _t_loop_end = time.perf_counter()

        yield f"data: {json.dumps({'type': 'assembling'})}\n\n"

        # ── Batch disk-write phase ────────────────────────────────────
        # Flush all per-segment WAVs and fingerprints in one burst now
        # that the GPU-hot loop is done. This keeps I/O off the critical
        # path and cuts ~200ms × N_segments of latency.
        _t_diskw_0 = time.perf_counter()
        hashes = job.setdefault("seg_hashes", {})
        quality_map = job.setdefault("seg_num_step", {})
        for (_si, _wav, _sr, _sid, _fp, _nstep) in _pending_seg_writes:
            seg_wav_path = os.path.join(DUB_DIR, job_id, f"seg_{_si}.wav")
            try:
                # Apply invisible watermark before writing to disk
                _wav = embed_watermark(_wav, _sr)
                torchaudio.save(seg_wav_path, _wav, _sr)
            except Exception as e:
                logger.warning("deferred seg write failed for %s: %s", _sid, e)
            if _fp is not None:
                hashes[_sid] = _fp
            quality_map[_sid] = _nstep
        # Single job flush instead of one per 8 segments.
        _save_job(job_id, job)
        _t_diskw = time.perf_counter() - _t_diskw_0

        sr = _model.sampling_rate
        total_samples = int(job["duration"] * sr)
        full_audio = torch.zeros(1, total_samples)

        slot_fit = (req.slot_fit or "time_stretch").lower()
        # Pre-compute each seg's neighbour start so the tail-allowance lookup
        # below is O(1). Assumes `all_segment_wavs` is in chronological order,
        # which it always is — segments come from a sorted transcript and we
        # don't reorder them anywhere upstream. Overlapping neighbours fall
        # back to gap=0 via the `max(0.0, ...)` clamp later.
        next_starts = [
            all_segment_wavs[i + 1][0] if i + 1 < len(all_segment_wavs) else job["duration"]
            for i in range(len(all_segment_wavs))
        ]

        for i, (start, end, wav, _) in enumerate(all_segment_wavs):
            s = int(start * sr)
            seg_ref = req.segments[i] if i < len(req.segments) else None
            seg_gain = getattr(seg_ref, "gain", None) if seg_ref is not None else None
            seg_gain = seg_gain if seg_gain is not None else 1.0
            seg_gain = max(0.0, min(2.0, seg_gain))
            adjusted = wav * seg_gain

            slot_samples = int(max(0.0, (end - start)) * sr)
            # Tail allowance: how far past `end` are we permitted to play
            # before we'd hit the next segment? Capped at _TAIL_ALLOWANCE_S so
            # a long silent gap doesn't let one line run on forever.
            gap_seconds = max(0.0, next_starts[i] - end)
            tail_seconds = min(_TAIL_ALLOWANCE_S, gap_seconds)
            allowed_samples = slot_samples + int(tail_seconds * sr)

            # Slot-fit: keep each seg from bleeding past its tail allowance.
            # "time_stretch" resamples via linear interpolation (slight pitch
            # lift on compression — negligible at ≤1.15×, audible at ≥1.3×).
            # "trim" hard-clips + relies on the longer fade-out below to mask
            # the cut. "off" is the legacy overlap behaviour.
            wl = adjusted.shape[-1]
            if slot_fit != "off" and allowed_samples > 0 and wl > allowed_samples:
                if slot_fit == "time_stretch":
                    try:
                        adjusted = torch.nn.functional.interpolate(
                            adjusted.unsqueeze(0),
                            size=allowed_samples,
                            mode='linear',
                            align_corners=False,
                        ).squeeze(0)
                    except Exception as e:
                        logger.warning("time_stretch failed for seg %d, falling back to trim: %s", i, e)
                        adjusted = adjusted[..., :allowed_samples]
                else:  # "trim"
                    adjusted = adjusted[..., :allowed_samples]
                wl = adjusted.shape[-1]

            start_fade = int((_START_FADE_MS / 1000.0) * sr)
            end_fade = int((_END_FADE_MS / 1000.0) * sr)
            # Longer end-fade hides any natural-tail trim and softens the
            # transition into the next seg / background-mix.
            if wl > start_fade + end_fade:
                if start_fade > 0:
                    ramp_up = torch.linspace(0, 1, start_fade, device=adjusted.device)
                    adjusted[0, :start_fade] *= ramp_up
                if end_fade > 0:
                    ramp_down = torch.linspace(1, 0, end_fade, device=adjusted.device)
                    adjusted[0, -end_fade:] *= ramp_down

            e = min(s + wl, total_samples)
            full_audio[:, s:e] += adjusted[:, :e - s]

        lang_code = req.language_code or "und"
        track_path = os.path.join(DUB_DIR, job_id, f"dubbed_{lang_code}.wav")
        _t_save_0 = time.perf_counter()
        # Apply invisible watermark to the final assembled track
        full_audio = embed_watermark(full_audio, sr)
        torchaudio.save(track_path, full_audio, sr)
        _t_save = time.perf_counter() - _t_save_0
        _t_mix = _t_save_0 - _t_loop_end
        job["dubbed_tracks"][lang_code] = {
            "path": track_path,
            "language": req.language,
            "language_code": lang_code,
        }

        job["language"] = req.language
        job["language_code"] = lang_code
        _save_job(job_id, job)

        _t_total = time.perf_counter() - _t_start
        logger.info(
            "bench[generate] total=%.2fs tts=%.2fs cache=%.2fs diskw=%.2fs mix=%.2fs save=%.2fs segs=%d%s",
            _t_total, _t_tts, _t_cache, _t_diskw, _t_mix, _t_save, total,
            f" regen={len(regen_only)}" if regen_only is not None else "",
        )

        yield f"data: {json.dumps({'type': 'done', 'segments_processed': total, 'language_code': lang_code, 'tracks': list(job['dubbed_tracks'].keys()), 'sync_scores': sync_scores, 'seg_hashes': job.get('seg_hashes', {}), 'seg_num_step': job.get('seg_num_step', {})})}\n\n"

    task_id = f"dub_{job_id}_{int(time.time())}"
    await task_manager.add_task(task_id, "dub_generate", _stream, task_id)
    return {"task_id": task_id}


# ── Real-time segment preview ──────────────────────────────────────────
# Stream TTS for a single segment without the full pipeline overhead.
# The frontend calls this when the user edits a segment's text/instruct
# and wants to hear the result immediately.

from pydantic import BaseModel
from typing import Optional
from fastapi.responses import Response
import io


class SegmentPreviewRequest(BaseModel):
    text: str
    language: str = "Auto"
    instruct: Optional[str] = None
    profile_id: Optional[str] = None
    speed: float = 1.0
    duration: Optional[float] = None


@router.post("/dub/preview-segment/{job_id}")
async def preview_segment(job_id: str, req: SegmentPreviewRequest):
    """Generate TTS for a single segment and return WAV bytes.

    This is the fast path for interactive editing — 8 diffusion steps,
    no disk write, no watermark, no mix. Just raw audio preview.
    """
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    _model = await get_model()

    def _gen():
        ref_audio = None
        ref_text = None

        # Resolve profile / auto-clone
        pid = req.profile_id
        if pid and pid.startswith("auto:"):
            key = pid[len("auto:"):]
            clones = job.get("speaker_clones") or {}
            for spk, info in clones.items():
                if spk.lower().replace(" ", "_") == key or spk == key:
                    ref_audio = info.get("ref_audio")
                    ref_text = info.get("ref_text")
                    break
            pid = None

        instruct_str = req.instruct
        if pid:
            with db_conn() as conn:
                row = conn.execute(
                    "SELECT * FROM voice_profiles WHERE id=?", (pid,)
                ).fetchone()
            if row:
                if row["is_locked"] and row["locked_audio_path"]:
                    ref_audio = os.path.join(VOICES_DIR, row["locked_audio_path"])
                    ref_text = row["ref_text"]
                elif row["ref_audio_path"]:
                    ref_audio = os.path.join(VOICES_DIR, row["ref_audio_path"])
                    ref_text = row["ref_text"]
                if not instruct_str and row["instruct"]:
                    instruct_str = row["instruct"]

        lang = req.language if req.language != "Auto" else None
        audios = _model.generate(
            text=req.text,
            language=lang,
            ref_audio=ref_audio,
            ref_text=ref_text,
            instruct=instruct_str if instruct_str else None,
            duration=req.duration,
            num_step=8,  # fast preview
            guidance_scale=2.0,
            speed=req.speed,
            denoise=True,
            postprocess_output=True,
        )
        audio_out = audios[0]
        # Preview chỉ render 1 đoạn để user nghe thử nhanh → hardcode broadcast
        # (đa số content phù hợp). Full render dùng audio_profile từ DubRequest.
        mastered = apply_mastering(
            audio_out,
            sample_rate=getattr(_model, "sampling_rate", 24000),
            profile="broadcast",
        )
        return normalize_audio(mastered, profile="broadcast")

    loop = asyncio.get_running_loop()
    audio_tensor = await loop.run_in_executor(_gpu_pool, _gen)

    sr = getattr(_model, "sampling_rate", 24000)
    buf = io.BytesIO()
    torchaudio.save(buf, audio_tensor, sr, format="wav")
    buf.seek(0)

    return Response(
        content=buf.read(),
        media_type="audio/wav",
        headers={
            "X-Audio-Duration": str(round(audio_tensor.shape[-1] / sr, 2)),
        },
    )

