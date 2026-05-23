import os
import io
import time
import uuid
import asyncio
import logging
from urllib.parse import quote
from typing import Optional
from fastapi import APIRouter, HTTPException, Query, Response, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse

from core.db import db_conn
from core.config import DUB_DIR
from core.tasks import task_manager
from api.routers.dub_core import _get_job, _save_job
from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

router = APIRouter()
logger = logging.getLogger("omnivoice.api")


def _unique_stamp() -> str:
    """Return a short unique suffix like '20260415T142301-ab12cd34' for export files."""
    return f"{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"


def _content_disposition(filename: str) -> str:
    # HTTP headers are latin-1; Unicode (e.g. Vietnamese) filenames need RFC 5987 encoding.
    ascii_fallback = filename.encode("ascii", "replace").decode("ascii").replace("?", "_").replace('"', "_")
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"


def _native_save(source: str, destination: str, display_name: str, media_type: str):
    """Copy a generated export file to a user-chosen destination and return JSON."""
    import shutil
    dest = os.path.expanduser(destination)
    # Reject traversal against the user's home dir — Tauri save dialog returns abs path.
    if not os.path.isabs(dest):
        raise HTTPException(status_code=400, detail="save_path must be absolute")
    try:
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        shutil.copy2(source, dest)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=f"Permission denied: {e}")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Copy failed: {e}")
    if not os.path.exists(dest) or os.path.getsize(dest) == 0:
        raise HTTPException(status_code=500, detail="Copy produced empty file at destination")
    logger.info("Native save wrote %s (%d bytes)", dest, os.path.getsize(dest))
    return {
        "saved": True,
        "path": dest,
        "size": os.path.getsize(dest),
        "media_type": media_type,
        "display_name": display_name,
    }

@router.get("/tasks/stream/{task_id}")
async def stream_task(task_id: str, after_seq: int = 0):
    """Universal Server-Sent Event stream for background tasks.

    `?after_seq=N` enables resumption: on reconnect, the client replays
    persisted events with seq > N, then (if the job is still live) attaches
    to the in-memory listener for live updates. After a server restart the
    in-memory task is gone but the persisted tail + final `jobs.status` are
    still readable, so a mid-stream reload still sees the final state.
    """
    from core import job_store
    job_row = job_store.get(task_id)
    live = task_manager.active_tasks.get(task_id)

    if not live and not job_row:
        raise HTTPException(
            status_code=404,
            detail="No such task. It may have been cleaned up or was never created.",
        )

    async def _reader():
        # 1) Replay any persisted events after the client's last-seen seq.
        try:
            persisted = job_store.events_since(task_id, after_seq=after_seq)
        except Exception:
            persisted = []
        for evt in persisted:
            yield evt["payload"]

        # 2) If the job has finished (whether in-memory or persisted-only), done.
        if not live:
            return
        if live["status"] in ("done", "failed", "cancelled"):
            return

        # 3) Attach to the in-memory listener for live updates.
        q = asyncio.Queue()
        await task_manager.add_listener(task_id, q)
        try:
            while True:
                evt = await q.get()
                if evt is None:
                    break
                yield evt
        finally:
            await task_manager.remove_listener(task_id, q)

    return StreamingResponse(_reader(), media_type="text/event-stream")


@router.get("/jobs")
async def list_jobs(status: str | None = None, project_id: str | None = None, limit: int = 100):
    """List persisted jobs, newest first.

    `status=active` → running + pending (what the batch-queue UI wants).
    `status=failed|done|cancelled|pending|running` → exact match.
    `project_id=...` → scope to one project.
    """
    from core import job_store
    limit = max(1, min(500, int(limit)))
    return job_store.list_jobs(status=status, project_id=project_id, limit=limit)


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    from core import job_store
    row = job_store.get(job_id)
    if not row:
        raise HTTPException(
            status_code=404,
            detail="No such job. It may have been cleaned up or never created.",
        )
    return row


@router.get("/jobs/{job_id}/events")
async def list_job_events(job_id: str, after_seq: int = 0, limit: int = 500):
    """Persisted SSE tail. Strict ascending seq so the client can stitch
    it onto a live feed (which starts above the last returned seq).
    """
    from core import job_store
    row = job_store.get(job_id)
    if not row:
        raise HTTPException(
            status_code=404,
            detail="No job with that id. It may have expired, been deleted, or the server restarted before it was persisted — check the dub history in the sidebar.",
        )
    limit = max(1, min(2000, int(limit)))
    return {
        "job": row,
        "events": job_store.events_since(job_id, after_seq=after_seq, limit=limit),
    }


@router.post("/tasks/cancel/{task_id}")
async def cancel_task(task_id: str):
    """Cancel a running background task (e.g. dub generation)."""
    ok = task_manager.cancel_task(task_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"cancelled": True, "task_id": task_id}


@router.get("/dub/tracks/{job_id}")
async def dub_list_tracks(job_id: str):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"tracks": job.get("dubbed_tracks", {})}


def _format_ass_time(seconds: float) -> str:
    """ASS dialogue time format: H:MM:SS.CC (centiseconds, single-digit hours)."""
    s = max(0.0, float(seconds))
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s - h * 3600 - m * 60
    return f"{h}:{m:02d}:{sec:05.2f}"


def _srt_italic_to_ass(text: str) -> str:
    """Convert `<i>...</i>` (SRT/HTML) to ASS inline `{\\i1}...{\\i0}` + escape ASS-special chars."""
    import re
    # Escape backslash + curly braces before italic substitution (else our own
    # `{\i1}` tags get re-escaped).
    text = text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
    text = re.sub(r"<i>(.*?)</i>", r"{\\i1}\1{\\i0}", text, flags=re.DOTALL | re.IGNORECASE)
    # ASS treats literal newlines as line breaks only via `\N` token.
    text = text.replace("\n", "\\N")
    return text


def _write_burn_subs(
    job: dict, exports_dir: str, stamp: str, dual: bool,
    snapshot_id: Optional[str] = None,
    max_chars_per_line: int = 32,
    max_lines: int = 2,
    max_cue_duration: float = 4.0,
    play_res_x: int = 1920,
    play_res_y: int = 1080,
) -> str | None:
    """Write an .ass file for ffmpeg's subtitles filter.

    Why ASS instead of SRT here:
      Khi ffmpeg consume SRT, libass dùng PlayResY mặc định = 288. FontSize=28
      tưởng là 28px nhưng thực tế render ở (28 / 288) ≈ 10%% chiều cao video
      → trên video 1080×1920 ra ~190px text khổng lồ, lệch hẳn preview.
      Bằng cách emit ASS với PlayResX/Y khớp video gốc, FontSize/MarginV được
      hiểu đúng theo pixel space của frame → preview WYSIWYG.

    Returns None if there are no segments to render. Path là ASCII basename
    nằm trong exports_dir → ffmpeg-filter-safe.
    """
    segments = _resolve_subtitle_segments(job, snapshot_id)
    if not segments:
        return None
    cues = _build_subtitle_cues(segments, dual, max_chars_per_line, max_lines, max_cue_duration)
    if not cues:
        return None
    # Base Style chỉ đặt placeholder — Alignment/MarginV/FontSize/BorderStyle
    # đều bị `force_style` từ caller override khi gọi subtitles filter. Giữ
    # default sane để nếu force_style fail thì vẫn xem được.
    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {int(play_res_x)}\n"
        f"PlayResY: {int(play_res_y)}\n"
        "ScaledBorderAndShadow: yes\n"
        "WrapStyle: 0\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        "Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,"
        "1,0,0,0,100,100,0,0,1,2,1,2,40,40,20,1\n"
        "\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    body_lines = []
    for start, end, text in cues:
        ass_text = _srt_italic_to_ass(text)
        body_lines.append(
            f"Dialogue: 0,{_format_ass_time(start)},{_format_ass_time(end)},Default,,0,0,0,,{ass_text}"
        )
    sub_path = os.path.join(exports_dir, f"burn_subs_{stamp}.ass")
    with open(sub_path, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(body_lines) + "\n")
    return sub_path


# ASS alignment numpad: 1-3 bottom row, 4-6 middle, 7-9 top
# Default = 2 (bottom-center, what most viewers expect).
_SUB_ALIGN_MAP = {
    "bottom": 2,
    "top": 8,
    "middle": 5,
}


def _hex_to_ass_color(hex_str: str, opacity_pct: int) -> str:
    """Convert `#RRGGBB` + opacity 0-100 → ASS color literal `&HAABBGGRR`.

    ASS dùng BGR order + AA là *transparency* (00 = đục, FF = trong suốt).
    Opacity 100% → AA = 00 (fully opaque). Opacity 0% → AA = FF (invisible).
    """
    s = (hex_str or "#000000").lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        s = "000000"
    try:
        r = int(s[0:2], 16)
        g = int(s[2:4], 16)
        b = int(s[4:6], 16)
    except ValueError:
        r = g = b = 0
    op = max(0, min(100, int(opacity_pct)))
    # ASS alpha: 00 = opaque, FF = transparent. Invert from opacity %.
    aa = round((100 - op) * 255 / 100)
    return f"&H{aa:02X}{b:02X}{g:02X}{r:02X}"


def _probe_video_dims(video_path: str) -> tuple[int, int]:
    """Read the video's (width, height) in pixels. Returns (0, 0) on failure.

    Burn-in ASS file embeds these as PlayResX/PlayResY so FontSize/MarginV
    are interpreted in actual video pixel space (else libass falls back to
    PlayResY=288 default → tiny FontSize ends up huge on tall video).
    """
    from services.ffmpeg_utils import find_ffprobe
    probe = find_ffprobe()
    if not probe:
        return (0, 0)
    try:
        import subprocess, json
        out = subprocess.check_output(
            [probe, "-v", "quiet", "-print_format", "json", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", video_path],
            timeout=10,
        )
        data = json.loads(out)
        streams = data.get("streams", [])
        if streams:
            return (int(streams[0].get("width") or 0), int(streams[0].get("height") or 0))
    except Exception:
        pass
    return (0, 0)


def _build_burn_style(
    position: str,
    margin_v: int,
    font_size: int,
    bg_color: str = "",
    bg_opacity: int = 0,
) -> str:
    """Build an ffmpeg `force_style` string for the subtitles filter.

    Khi `bg_opacity > 0`, switch `BorderStyle=3` (opaque box) và set
    `BackColour` từ hex + opacity. Khi 0 → BorderStyle=1 (outline-only,
    text-shadow style như default).
    """
    align = _SUB_ALIGN_MAP.get((position or "bottom").lower(), 2)
    margin = max(0, min(500, int(margin_v)))
    size = max(10, min(80, int(font_size)))
    parts = [f"Alignment={align}", f"MarginV={margin}", f"FontSize={size}"]
    if bg_color and int(bg_opacity) > 0:
        ass_bg = _hex_to_ass_color(bg_color, bg_opacity)
        # BorderStyle=3 → opaque rectangular background; Outline = padding around text.
        parts += ["BorderStyle=3", f"BackColour={ass_bg}", "Outline=4", "Shadow=0"]
    return ",".join(parts)


# ── Custom background audio ─────────────────────────────────────────────

_ALLOWED_BG_EXTS = {".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac", ".opus"}


def _resolve_bg(job: dict, bg_source: str) -> Optional[str]:
    """Map bg_source → audio file path. None khi 'off' hoặc thiếu file."""
    src = (bg_source or "original").lower()
    if src == "off":
        return None
    if src == "custom":
        p = job.get("custom_bg_path")
        return p if (p and os.path.exists(p)) else None
    # "original" (default) → Demucs no-vocals stem
    p = job.get("no_vocals_path")
    return p if (p and os.path.exists(p)) else None


def _amix_weights(bg_volume: float) -> str:
    """Build ffmpeg amix `weights` string from a 0-2.0 BG volume slider.

    Voice giữ ổn định ở 1.2 (≈ +1.6 dB headroom). BG nhân theo slider, clamp
    để tránh đè giọng (0.0–2.0 → 0.0–2.0).
    """
    bg = max(0.0, min(2.0, float(bg_volume)))
    return f"{bg:.2f} 1.2"


@router.post("/dub/bg/{job_id}")
async def upload_custom_bg(job_id: str, file: UploadFile = File(...)):
    """Upload a custom background audio file. Replaces previous custom BG."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in _ALLOWED_BG_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"Định dạng {ext or '(rỗng)'} không hỗ trợ. Dùng wav/mp3/m4a/aac/ogg/flac/opus.",
        )
    try:
        raw = await file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Đọc file thất bại: {e}") from e
    if not raw:
        raise HTTPException(status_code=400, detail="File rỗng")

    bg_dir = os.path.join(DUB_DIR, job_id, "exports")
    os.makedirs(bg_dir, exist_ok=True)
    # Cleanup previous custom BG nếu khác extension (tránh tích file cũ)
    prev = job.get("custom_bg_path")
    if prev and os.path.exists(prev) and prev != os.path.join(bg_dir, f"custom_bg{ext}"):
        try:
            os.remove(prev)
        except OSError:
            pass
    bg_path = os.path.join(bg_dir, f"custom_bg{ext}")
    with open(bg_path, "wb") as f:
        f.write(raw)

    job["custom_bg_path"] = bg_path
    job["custom_bg_filename"] = file.filename or os.path.basename(bg_path)
    _save_job(job_id, job)
    return {
        "ok": True,
        "filename": job["custom_bg_filename"],
        "size_bytes": len(raw),
    }


@router.get("/dub/bg/{job_id}")
async def get_custom_bg_info(job_id: str):
    """Return metadata về custom BG đang được lưu (nếu có)."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    p = job.get("custom_bg_path")
    if not p or not os.path.exists(p):
        return {"exists": False}
    return {
        "exists": True,
        "filename": job.get("custom_bg_filename") or os.path.basename(p),
        "size_bytes": os.path.getsize(p),
    }


@router.delete("/dub/bg/{job_id}")
async def delete_custom_bg(job_id: str):
    """Remove the stored custom BG file + clear pointer in job."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    p = job.get("custom_bg_path")
    if p and os.path.exists(p):
        try:
            os.remove(p)
        except OSError as e:
            logger.warning("custom_bg cleanup failed for %s: %s", job_id, e)
    job.pop("custom_bg_path", None)
    job.pop("custom_bg_filename", None)
    _save_job(job_id, job)
    return {"deleted": True}


def _ffmpeg_filter_escape(path: str) -> str:
    """Escape a path for use inside an ffmpeg filter value (subtitles=...).

    ffmpeg's filter parser treats `:` as an option separator and `\\`, `'` specially.
    Backslashes first, then colons, then single quotes.
    """
    return path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


@router.get("/dub/download/{job_id}")
@router.get("/dub/download/{job_id}/{filename}")
async def dub_download(
    job_id: str,
    preserve_bg: bool = Query(True, description="Legacy: bật/tắt BG. Khi bg_source được truyền, param này bị bỏ qua."),
    bg_source: Optional[str] = Query(None, description="original | custom | off. Override preserve_bg."),
    bg_volume: float = Query(0.8, description="BG volume multiplier (0.0–2.0). Default 0.8 = nhẹ dưới giọng."),
    default_track: str = Query("original"),
    include_tracks: str = Query("", description="Comma-separated list of tracks to include (e.g. 'original,de,es'). Empty = include all."),
    save_path: str = Query("", description="Absolute destination path. If set, mux output is copied there and JSON returned instead of FileResponse."),
    burn_subs: bool = Query(False, description="Burn subtitles into the video stream (forces re-encode). Uses dual-subtitle layout when dual=1."),
    dual: bool = Query(False, description="When burn_subs=1, render translated on top of italicised original."),
    sub_snapshot_id: Optional[str] = Query(None, description="Translation snapshot id để chọn ngôn ngữ sub burn-in."),
    sub_position: str = Query("bottom", description="bottom | middle | top — vị trí dọc của burn-in subtitle."),
    sub_margin_v: int = Query(20, description="Margin từ cạnh anchor (pixel). 0-500. Bị override bởi sub_margin_v_pct nếu > 0."),
    sub_margin_v_pct: float = Query(0.0, description="Margin từ cạnh anchor theo %% video height (0-50). > 0 sẽ override sub_margin_v."),
    sub_font_size: int = Query(24, description="Font size cho burn-in. 10-80."),
    sub_bg_color: str = Query("", description="Hex màu nền sub (#RRGGBB). Rỗng = không có nền."),
    sub_bg_opacity: int = Query(0, description="Opacity nền sub 0-100%. 0 = không có nền."),
    sub_max_chars_per_line: int = Query(32, description="Max ký tự / dòng — segs dài tự split."),
    sub_max_lines: int = Query(2, description="Max dòng / cue."),
    sub_max_cue_duration: float = Query(4.0, description="Max giây / cue. Cue dài hơn tự split để bám nhịp đọc."),
):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    tracks = job.get("dubbed_tracks", {})
    if not tracks:
        raise HTTPException(status_code=400, detail="No dubbed tracks generated yet")

    include_set = set(t.strip() for t in include_tracks.split(",") if t.strip()) if include_tracks else None
    include_original = include_set is None or "original" in include_set

    if include_set:
        filtered_tracks = {k: v for k, v in tracks.items() if k in include_set}
    else:
        filtered_tracks = dict(tracks)

    if not filtered_tracks and not include_original:
        raise HTTPException(status_code=400, detail="No tracks selected for export")

    video_path = job["video_path"]
    stamp = _unique_stamp()
    exports_dir = os.path.join(DUB_DIR, job_id, "exports")
    os.makedirs(exports_dir, exist_ok=True)
    output_path = os.path.join(exports_dir, f"dubbed_video_{stamp}.mp4")
    ffmpeg = find_ffmpeg()

    # Probe video dims once — used for both ASS PlayResY embedding AND
    # converting % margin to pixel margin in PlayResY space.
    # to_thread vì subprocess.check_output là sync, đừng block event loop khi
    # nhiều job download song song.
    video_w, video_h = await asyncio.to_thread(_probe_video_dims, video_path) if burn_subs else (0, 0)

    sub_path = _write_burn_subs(
        job, exports_dir, stamp, dual, sub_snapshot_id,
        sub_max_chars_per_line, sub_max_lines, sub_max_cue_duration,
        play_res_x=video_w or 1920,
        play_res_y=video_h or 1080,
    ) if burn_subs else None

    # Resolve margin: pct > 0 → convert to px theo height của source video.
    # ASS MarginV nằm trong PlayResY space (= video height nhờ ASS header).
    effective_margin_v = sub_margin_v
    if burn_subs and sub_margin_v_pct and sub_margin_v_pct > 0 and video_h > 0:
        pct = max(0.0, min(50.0, float(sub_margin_v_pct)))
        effective_margin_v = int(round(video_h * pct / 100.0))

    cmd = [ffmpeg, "-i", video_path]
    input_idx = 1

    # Resolve BG: explicit bg_source wins over legacy preserve_bg toggle. Khi
    # bg_source = None thì fallback về preserve_bg (giữ tương thích client cũ).
    effective_source = bg_source or ("original" if preserve_bg else "off")
    bg_audio = _resolve_bg(job, effective_source)
    bg_idx = None
    if bg_audio and filtered_tracks:
        cmd += ["-i", bg_audio]
        bg_idx = input_idx
        input_idx += 1

    tracks_to_process = []
    for lang_code, track_info in filtered_tracks.items():
        cmd += ["-i", track_info["path"]]
        tracks_to_process.append({"lang_code": lang_code, "idx": input_idx, "info": track_info})
        input_idx += 1

    filter_parts: list[str] = []
    video_map = "0:v:0"
    if sub_path:
        esc = _ffmpeg_filter_escape(sub_path)
        style = _build_burn_style(sub_position, effective_margin_v, sub_font_size, sub_bg_color, sub_bg_opacity)
        filter_parts.append(f"[0:v]subtitles='{esc}':force_style='{style}'[vout]")
        video_map = "[vout]"

    cmd += ["-map", video_map]
    if include_original:
        cmd += ["-map", "0:a:0"]

    if bg_idx is not None:
        weights = _amix_weights(bg_volume)
        for i, t in enumerate(tracks_to_process):
            out_label = f"[aout{i}]"
            filter_parts.append(f"[{bg_idx}:a][{t['idx']}:a]amix=inputs=2:duration=longest:dropout_transition=2:weights={weights}{out_label}")
            t["out_label"] = out_label
        for t in tracks_to_process:
            cmd += ["-map", t["out_label"]]
    else:
        for t in tracks_to_process:
            cmd += ["-map", f"{t['idx']}:a:0"]

    if filter_parts:
        cmd += ["-filter_complex", ";".join(filter_parts)]

    # Burning subs forces a video re-encode; stream-copy otherwise to keep mux cheap.
    if sub_path:
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"]
    else:
        cmd += ["-c:v", "copy"]
    cmd += ["-c:a", "aac", "-b:a", "192k"]

    audio_stream_idx = 0
    if include_original:
        cmd += [f"-metadata:s:a:{audio_stream_idx}", "language=und", f"-metadata:s:a:{audio_stream_idx}", "title=Original"]
        audio_stream_idx += 1

    for t in tracks_to_process:
        cmd += [
            f"-metadata:s:a:{audio_stream_idx}", f"language={t['lang_code']}",
            f"-metadata:s:a:{audio_stream_idx}", f"title={t['info']['language']}"
        ]
        t["stream_idx"] = audio_stream_idx
        audio_stream_idx += 1

    total_audio = (1 if include_original else 0) + len(tracks_to_process)
    for i in range(total_audio):
        cmd += [f"-disposition:a:{i}", "0"]

    if default_track == "original" and include_original:
        cmd += ["-disposition:a:0", "default"]
    else:
        target_idx = 0
        for t in tracks_to_process:
            if t['lang_code'] == default_track:
                target_idx = t["stream_idx"]
                break
        cmd += [f"-disposition:a:{target_idx}", "default"]

    cmd += ["-shortest", output_path, "-y"]

    try:
        rc, _, stderr = await run_ffmpeg(cmd, timeout=1800.0)
        if rc != 0:
            raise Exception(stderr.decode(errors="replace") if stderr else "ffmpeg mux non-zero")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="ffmpeg mux timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"ffmpeg failed to combine video + dubbed audio: {e}. Verify ffmpeg is installed (`ffmpeg -version`), and check that every dubbed track file exists in the job folder.",
        )

    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        raise HTTPException(status_code=500, detail="ffmpeg mux produced no output file")
    logger.info("Dub mux wrote %s (%d bytes)", output_path, os.path.getsize(output_path))

    base_name = os.path.splitext(job.get('filename', 'output'))[0]
    safe_name = ''.join(c for c in base_name if c.isalnum() or c in '-_ ').strip() or 'output'
    dl_name = f"dubbed_{safe_name}_{stamp}.mp4"

    if save_path:
        return _native_save(output_path, save_path, dl_name, media_type="video/mp4")

    return FileResponse(
        output_path, media_type="video/mp4",
        headers={"Content-Disposition": _content_disposition(dl_name)},
    )


@router.get("/dub/media/{job_id}")
async def dub_get_media(job_id: str):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if not os.path.exists(job["video_path"]):
        raise HTTPException(status_code=404, detail="Media file not found")
    return FileResponse(job["video_path"])

@router.get("/dub/preview-video/{job_id}")
async def dub_preview_video(
    job_id: str,
    lang: str = Query(..., description="Language code of the dubbed track to mux in"),
    preserve_bg: bool = Query(True),
):
    """Return an inline-playable MP4 with the chosen dubbed track as sole audio.

    Caches per lang+preserve_bg combination under exports/preview_{lang}_{bg}.mp4.
    Cache is invalidated when the underlying dubbed track mtime is newer than the cache.
    """
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    tracks = job.get("dubbed_tracks", {})
    track_info = tracks.get(lang)
    if not track_info:
        raise HTTPException(status_code=404, detail=f"No dubbed track for lang={lang}")

    track_path = track_info.get("path")
    if not track_path or not os.path.exists(track_path):
        raise HTTPException(status_code=404, detail="Dubbed track file missing")

    video_path = job.get("video_path")
    if not video_path or not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="Source video missing")

    bg_audio = job.get("no_vocals_path") if preserve_bg else None
    has_bg = bool(bg_audio and os.path.exists(bg_audio))

    exports_dir = os.path.join(DUB_DIR, job_id, "exports")
    os.makedirs(exports_dir, exist_ok=True)
    bg_suffix = "bg" if (preserve_bg and has_bg) else "nobg"
    preview_path = os.path.join(exports_dir, f"preview_{lang}_{bg_suffix}.mp4")

    track_mtime = os.path.getmtime(track_path)
    cache_ok = (
        os.path.exists(preview_path)
        and os.path.getsize(preview_path) > 0
        and os.path.getmtime(preview_path) >= track_mtime
    )

    if not cache_ok:
        ffmpeg = find_ffmpeg()
        cmd = [ffmpeg, "-i", video_path]
        input_idx = 1
        if preserve_bg and has_bg:
            cmd += ["-i", bg_audio]
            bg_idx = input_idx
            input_idx += 1
        else:
            bg_idx = None
        cmd += ["-i", track_path]
        track_idx = input_idx

        cmd += ["-map", "0:v:0"]
        if bg_idx is not None:
            cmd += [
                "-filter_complex",
                f"[{bg_idx}:a][{track_idx}:a]amix=inputs=2:duration=longest:dropout_transition=2:weights=0.8 1.2[aout]",
                "-map", "[aout]",
            ]
        else:
            cmd += ["-map", f"{track_idx}:a:0"]
        cmd += ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", preview_path, "-y"]

        try:
            rc, _, stderr = await run_ffmpeg(cmd, timeout=900.0)
            if rc != 0:
                raise Exception(stderr.decode(errors="replace") if stderr else "ffmpeg mux non-zero")
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="preview mux timed out")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"ffmpeg failed to build the preview stream: {str(e)[:300]}. This usually means the source video can't be re-encoded on the fly — try downloading the MP4 instead.",
            )

        if not os.path.exists(preview_path) or os.path.getsize(preview_path) == 0:
            raise HTTPException(status_code=500, detail="preview mux produced empty file")

    return FileResponse(preview_path, media_type="video/mp4")


@router.get("/dub/thumb/{job_id}")
async def dub_get_thumb(job_id: str):
    """Serve the extracted dub video thumbnail (jpg). 404 if not generated."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    # Resolve under DUB_DIR to prevent traversal.
    thumb = os.path.join(DUB_DIR, job_id, "thumb.jpg")
    if not os.path.exists(thumb):
        raise HTTPException(status_code=404, detail="Thumbnail not available")
    return FileResponse(thumb, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=3600"})

@router.get("/dub/audio/{job_id}")
async def dub_get_audio(job_id: str):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    audio = job.get("audio_path")
    if not audio or not os.path.exists(audio):
        raise HTTPException(status_code=404, detail="Audio file not found")
    return FileResponse(audio, media_type="audio/wav")

@router.get("/dub/preview/{job_id}/{segment_index}")
async def dub_preview_segment(job_id: str, segment_index: int):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    seg_path = os.path.join(DUB_DIR, job_id, f"seg_{segment_index}.wav")
    if not os.path.exists(seg_path):
        raise HTTPException(status_code=404, detail="Segment not generated yet")
    return FileResponse(seg_path, media_type="audio/wav")


@router.get("/dub/download-audio/{job_id}")
@router.get("/dub/download-audio/{job_id}/{filename}")
async def dub_download_audio(
    job_id: str,
    lang: str = Query(None),
    preserve_bg: bool = Query(True),
    bg_source: Optional[str] = Query(None),
    bg_volume: float = Query(0.8),
    save_path: str = Query(""),
):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    tracks = job.get("dubbed_tracks", {})
    if lang and lang in tracks:
        wav_path = tracks[lang]["path"]
    elif tracks:
        wav_path = list(tracks.values())[0]["path"]
    else:
        raise HTTPException(status_code=400, detail="No dubbed audio track generated yet")

    if not os.path.exists(wav_path):
        raise HTTPException(status_code=404, detail="Audio file not found")

    lang_label = lang or list(tracks.keys())[0]
    stamp = _unique_stamp()
    exports_dir = os.path.join(DUB_DIR, job_id, "exports")
    os.makedirs(exports_dir, exist_ok=True)

    effective_source = bg_source or ("original" if preserve_bg else "off")
    bg_audio = _resolve_bg(job, effective_source)
    if bg_audio:
        ffmpeg = find_ffmpeg()
        final_audio_path = os.path.join(exports_dir, f"mixed_dub_{lang_label}_{stamp}.wav")
        weights = _amix_weights(bg_volume)
        cmd = [
            ffmpeg, "-i", bg_audio, "-i", wav_path,
            "-filter_complex", f"[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2:weights={weights}[aout]",
            "-map", "[aout]", "-c:a", "pcm_s16le", "-y", final_audio_path
        ]
        try:
            rc, _, stderr = await run_ffmpeg(cmd, timeout=900.0)
            if rc != 0:
                raise Exception(stderr.decode(errors="replace") if stderr else "ffmpeg mix non-zero")
            if not os.path.exists(final_audio_path) or os.path.getsize(final_audio_path) == 0:
                raise Exception("ffmpeg mix produced no output file")
            wav_path = final_audio_path
            logger.info("Dub audio mix wrote %s (%d bytes)", final_audio_path, os.path.getsize(final_audio_path))
        except Exception as e:
            logger.error(f"Failed to mix audio: {str(e)}")

    base_name = os.path.splitext(job.get('filename', 'audio'))[0]
    safe_name = ''.join(c for c in base_name if c.isalnum() or c in '-_ ').strip() or 'audio'
    dl_name = f"dubbed_audio_{lang_label}_{safe_name}_{stamp}.wav"
    if save_path:
        return _native_save(wav_path, save_path, dl_name, media_type="audio/wav")
    return FileResponse(
        wav_path, media_type="audio/wav",
        headers={"Content-Disposition": _content_disposition(dl_name)},
    )


def _format_srt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def _pick_subtitle_text(seg: dict, dual: bool) -> str:
    """One line per subtitle cue, unless dual=true and an original exists.

    Dual layout stacks translated text on top of the (italicised) original, the
    way Netflix / language-learning apps present them:

        Das Spiel wirklich zu verändern.
        <i>Actually change the game.</i>
    """
    translated = (seg.get("text") or "").strip()
    original = (seg.get("text_original") or "").strip()
    if not dual or not original or original == translated:
        return translated or original
    return f"{translated}\n<i>{original}</i>"


_SENTENCE_END_RE = None


def _wrap_text_for_subtitle(text: str, max_chars_per_line: int, max_lines: int) -> list[str]:
    """Break a long string into chunks each ≤ max_lines × max_chars_per_line.

    Strategy:
      1. Sentence boundary (., !, ?, 。, ！, ？) là chỗ split ưu tiên.
      2. Trong mỗi câu, wrap thành nhiều dòng ≤ max_chars_per_line, ưu tiên
         space. Tránh cắt giữa từ.
      3. Mỗi chunk gom đủ max_lines dòng rồi mới sang chunk mới.
    """
    import re
    if max_chars_per_line <= 0 or max_lines <= 0:
        return [text]
    text = (text or "").strip()
    if not text:
        return []

    # Tách câu giữ luôn dấu kết
    sentence_re = re.compile(r'[^.!?。！？]+[.!?。！？]?', re.UNICODE)
    raw_sentences = [s.strip() for s in sentence_re.findall(text) if s.strip()]
    if not raw_sentences:
        raw_sentences = [text]

    # Wrap từng câu → list[str] line
    all_lines: list[str] = []
    for sentence in raw_sentences:
        words = sentence.split()
        if not words:
            continue
        current = ""
        for w in words:
            # Từ dài hơn max → đành nhả 1 dòng riêng (không cắt mid-word)
            if len(w) > max_chars_per_line:
                if current:
                    all_lines.append(current)
                    current = ""
                all_lines.append(w)
                continue
            candidate = (current + " " + w).strip() if current else w
            if len(candidate) <= max_chars_per_line:
                current = candidate
            else:
                all_lines.append(current)
                current = w
        if current:
            all_lines.append(current)

    # Gom các dòng thành chunks ≤ max_lines dòng/chunk
    chunks: list[str] = []
    for i in range(0, len(all_lines), max_lines):
        chunks.append("\n".join(all_lines[i:i + max_lines]))
    return chunks or [text]


def _split_segment_into_cues(
    seg: dict, dual: bool, max_chars_per_line: int, max_lines: int,
    max_cue_duration: float = 4.0,
) -> list[tuple[float, float, str]]:
    """Split 1 seg thành nhiều cue dạng (start, end, text).

    Time phân bố theo char count của từng chunk. Khi dual=True và có
    `text_original`, chunk theo text translated rồi giữ original cho TỪNG chunk
    (lấy chunk tương ứng — proportional split để 2 ngôn ngữ vẫn align).

    `max_cue_duration` (s): nếu sau khi wrap, avg duration/chunk > limit này,
    re-wrap với max_lines=1 để sub flow theo nhịp đọc thay vì đứng yên cả câu.
    """
    start = float(seg.get("start") or 0.0)
    end = float(seg.get("end") or start)
    duration = max(0.001, end - start)

    translated = (seg.get("text") or "").strip()
    original = (seg.get("text_original") or "").strip()

    primary = translated or original
    chunks = _wrap_text_for_subtitle(primary, max_chars_per_line, max_lines)
    if not chunks:
        return []

    # Pacing guard: chunks quá ít so với duration → sub dai. Force re-wrap với
    # max_lines=1 nếu avg > max_cue_duration. Nếu vẫn dai (1 chunk = nguyên seg
    # ngắn text), split thêm bằng cách halving lines.
    effective_max_lines = max_lines
    if max_cue_duration > 0 and duration / len(chunks) > max_cue_duration and max_lines > 1:
        chunks = _wrap_text_for_subtitle(primary, max_chars_per_line, 1)
        effective_max_lines = 1

    # Pre-wrap original once, không gọi trong loop. Khi len(orig) ≠ len(chunks),
    # map proportional index để tránh vừa repeat dòng cuối vừa drop dòng giữa.
    orig_chunks: list[str] = []
    if dual and original and original != translated:
        orig_chunks = _wrap_text_for_subtitle(original, max_chars_per_line, effective_max_lines)

    # Time allocation theo char weight, tổng = duration
    weights = [max(1, len(c.replace("\n", " "))) for c in chunks]
    total_w = sum(weights)
    cues: list[tuple[float, float, str]] = []
    cursor = start
    n_chunks = len(chunks)
    for i, (chunk, w) in enumerate(zip(chunks, weights)):
        share = duration * (w / total_w)
        c_start = cursor
        c_end = end if i == n_chunks - 1 else min(end, cursor + share)
        cursor = c_end
        text_for_cue = chunk
        if orig_chunks:
            # Proportional index map: chunk i → orig_chunks[ round(i / N * M) ]
            # đảm bảo monotonic non-decreasing, không bỏ giữa cũng không repeat lệch.
            orig_idx = min(len(orig_chunks) - 1, int(i * len(orig_chunks) / max(1, n_chunks)))
            text_for_cue = f"{chunk}\n<i>{orig_chunks[orig_idx]}</i>"
        cues.append((c_start, c_end, text_for_cue))
    return cues


def _build_subtitle_cues(
    segments: list[dict], dual: bool,
    max_chars_per_line: int = 32, max_lines: int = 2,
    max_cue_duration: float = 4.0,
) -> list[tuple[float, float, str]]:
    """Build all cues for all segs, in chronological order. Each seg may produce
    multiple cues when its text exceeds the per-cue budget."""
    out: list[tuple[float, float, str]] = []
    for seg in segments:
        out.extend(_split_segment_into_cues(
            seg, dual, max_chars_per_line, max_lines, max_cue_duration,
        ))
    return out


def _resolve_subtitle_segments(job: dict, snapshot_id: Optional[str]) -> list[dict]:
    """Build the list of segments to render as subtitle cues.

    Default = current `job["segments"]` (latest applied translation).
    Khi `snapshot_id` được truyền → overlay snapshot rows lên seg metadata
    (giữ start/end + text_original), thay text bằng snapshot rows.text. Cho
    phép xuất sub ở bất kỳ ngôn ngữ nào user đã từng dịch, không cần phải
    restore snapshot vào segments hiện tại.
    """
    segments = job.get("segments") or []
    if not snapshot_id:
        return segments
    snaps = job.get("translations") or []
    snap = next((s for s in snaps if s.get("id") == snapshot_id), None)
    if not snap:
        return segments
    by_id = {str(r.get("id")): r for r in (snap.get("rows") or [])}
    out: list[dict] = []
    for seg in segments:
        row = by_id.get(str(seg.get("id", "")))
        if not row or row.get("error"):
            # Snapshot không có hoặc lỗi → fall back về text hiện tại
            out.append(seg)
            continue
        new_text = (row.get("text") or "").strip()
        if not new_text:
            out.append(seg)
            continue
        out.append({**seg, "text": new_text})
    return out


@router.get("/dub/srt/{job_id}")
@router.get("/dub/srt/{job_id}/{filename}")
async def dub_export_srt(
    job_id: str,
    dual: bool = False,
    snapshot_id: Optional[str] = Query(None, description="Translation snapshot id để chọn ngôn ngữ sub (default = current segments)"),
    max_chars_per_line: int = Query(32, description="Max ký tự / dòng. SRT chuẩn ≤42, hẹp hơn cho Reels/Shorts."),
    max_lines: int = Query(2, description="Max dòng / cue. Sub thường 2 dòng."),
    max_cue_duration: float = Query(4.0, description="Max giây / cue. Cue dài hơn tự split."),
):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    segments = _resolve_subtitle_segments(job, snapshot_id)
    if not segments:
        raise HTTPException(status_code=400, detail="No transcript segments available")

    cues = _build_subtitle_cues(segments, dual, max_chars_per_line, max_lines, max_cue_duration)
    srt_lines = []
    for i, (start, end, text) in enumerate(cues):
        srt_lines.append(f"{i + 1}")
        srt_lines.append(f"{_format_srt_time(start)} --> {_format_srt_time(end)}")
        srt_lines.append(text)
        srt_lines.append("")

    srt_content = "\n".join(srt_lines)
    base_name = os.path.splitext(job.get('filename', 'video'))[0]
    suffix = "_dual" if dual else ""
    return Response(
        content=srt_content,
        media_type="text/plain",
        headers={"Content-Disposition": _content_disposition(f"subtitles_{base_name}{suffix}.srt")},
    )

def _format_vtt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"

@router.get("/dub/vtt/{job_id}")
@router.get("/dub/vtt/{job_id}/{filename}")
async def dub_export_vtt(
    job_id: str,
    dual: bool = False,
    snapshot_id: Optional[str] = Query(None, description="Translation snapshot id để chọn ngôn ngữ sub"),
    max_chars_per_line: int = Query(32),
    max_lines: int = Query(2),
    max_cue_duration: float = Query(4.0),
):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    segments = _resolve_subtitle_segments(job, snapshot_id)
    if not segments:
        raise HTTPException(status_code=400, detail="No transcript segments available")

    cues = _build_subtitle_cues(segments, dual, max_chars_per_line, max_lines, max_cue_duration)
    vtt_lines = ["WEBVTT", ""]
    for i, (start, end, text) in enumerate(cues):
        vtt_lines.append(str(i + 1))
        vtt_lines.append(f"{_format_vtt_time(start)} --> {_format_vtt_time(end)}")
        vtt_lines.append(text)
        vtt_lines.append("")

    vtt_content = "\n".join(vtt_lines)
    base_name = os.path.splitext(job.get('filename', 'video'))[0]
    suffix = "_dual" if dual else ""
    return Response(
        content=vtt_content,
        media_type="text/vtt",
        headers={"Content-Disposition": _content_disposition(f"subtitles_{base_name}{suffix}.vtt")},
    )


@router.get("/dub/export-segments/{job_id}")
async def dub_export_segments_zip(job_id: str):
    import zipfile
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    segments = job.get("segments", [])
    if not segments:
        raise HTTPException(status_code=400, detail="No segments available")

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, seg in enumerate(segments):
            seg_path = os.path.join(DUB_DIR, job_id, f"seg_{i}.wav")
            if os.path.exists(seg_path):
                speaker = seg.get("speaker_id", "Speaker1").replace(" ", "")
                start_str = f"{seg['start']:.2f}"
                end_str = f"{seg['end']:.2f}"
                arc_name = f"{i+1:03d}_{start_str}-{end_str}_{speaker}.wav"
                zf.write(seg_path, arc_name)

    zip_buffer.seek(0)
    base_name = os.path.splitext(job.get('filename', 'video'))[0]
    safe_name = ''.join(c for c in base_name if c.isalnum() or c in '-_ ').strip() or 'segments'
    return Response(
        content=zip_buffer.read(),
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(f"segments_{safe_name}.zip")},
    )

@router.get("/dub/download-mp3/{job_id}")
@router.get("/dub/download-mp3/{job_id}/{filename}")
async def dub_download_mp3(
    job_id: str,
    lang: str = Query(None),
    preserve_bg: bool = Query(True),
    bg_source: Optional[str] = Query(None),
    bg_volume: float = Query(0.8),
    save_path: str = Query(""),
    bitrate: str = Query("192k"),
):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    tracks = job.get("dubbed_tracks", {})
    if lang and lang in tracks:
        wav_path = tracks[lang]["path"]
    elif tracks:
        wav_path = list(tracks.values())[0]["path"]
    else:
        raise HTTPException(status_code=400, detail="No dubbed audio track generated yet")

    if not os.path.exists(wav_path):
        raise HTTPException(status_code=404, detail="Audio file not found")

    lang_label = lang or list(tracks.keys())[0]
    ffmpeg = find_ffmpeg()
    stamp = _unique_stamp()
    exports_dir = os.path.join(DUB_DIR, job_id, "exports")
    os.makedirs(exports_dir, exist_ok=True)

    source_path = wav_path
    effective_source = bg_source or ("original" if preserve_bg else "off")
    bg_audio = _resolve_bg(job, effective_source)
    if bg_audio:
        mixed_path = os.path.join(exports_dir, f"mixed_mp3_{lang_label}_{stamp}.wav")
        weights = _amix_weights(bg_volume)
        cmd_mix = [
            ffmpeg, "-i", bg_audio, "-i", wav_path,
            "-filter_complex", f"[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2:weights={weights}[aout]",
            "-map", "[aout]", "-c:a", "pcm_s16le", "-y", mixed_path
        ]
        try:
            rc, _, _ = await run_ffmpeg(cmd_mix, timeout=900.0)
            if rc == 0 and os.path.exists(mixed_path) and os.path.getsize(mixed_path) > 0:
                source_path = mixed_path
        except Exception as e:
            logger.error(f"Failed to mix audio for MP3: {e}")

    mp3_path = os.path.join(exports_dir, f"dubbed_{lang_label}_{stamp}.mp3")
    # Accept '128', '192k' etc. — normalize to ffmpeg's 'Nk' form and clamp
    # to a sensible range so a malformed value can't stall encoding.
    _br = str(bitrate or "192k").lower().rstrip("k") or "192"
    try:
        _br_int = max(64, min(int(_br), 320))
    except ValueError:
        _br_int = 192
    br_arg = f"{_br_int}k"
    cmd = [ffmpeg, "-i", source_path, "-codec:a", "libmp3lame", "-b:a", br_arg, "-y", mp3_path]
    try:
        rc, _, stderr = await run_ffmpeg(cmd, timeout=600.0)
        if rc != 0:
            raise Exception(stderr.decode(errors="replace") if stderr else "MP3 encode non-zero")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="MP3 encoding timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"ffmpeg couldn't encode MP3: {e}. Check that libmp3lame is compiled into your ffmpeg build (`ffmpeg -codecs | grep mp3`) — reinstall via homebrew if it's missing.",
        )

    if not os.path.exists(mp3_path) or os.path.getsize(mp3_path) == 0:
        raise HTTPException(status_code=500, detail="MP3 encoding produced no output file")
    logger.info("Dub MP3 encoded %s (%d bytes)", mp3_path, os.path.getsize(mp3_path))

    base_name = os.path.splitext(job.get('filename', 'audio'))[0]
    safe_name = ''.join(c for c in base_name if c.isalnum() or c in '-_ ').strip() or 'audio'
    dl_name = f"dubbed_{lang_label}_{safe_name}_{stamp}.mp3"
    if save_path:
        return _native_save(mp3_path, save_path, dl_name, media_type="audio/mpeg")
    return FileResponse(
        mp3_path, media_type="audio/mpeg",
        headers={"Content-Disposition": _content_disposition(dl_name)},
    )

@router.get("/dub/export-stems/{job_id}")
async def dub_export_stems(job_id: str, lang: str = Query(None)):
    import zipfile
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    tracks = job.get("dubbed_tracks", {})
    if not tracks:
        raise HTTPException(status_code=400, detail="No dubbed tracks generated yet")

    if lang and lang in tracks:
        vocals_path = tracks[lang]["path"]
        lang_label = lang
    elif tracks:
        first_key = list(tracks.keys())[0]
        vocals_path = tracks[first_key]["path"]
        lang_label = first_key
    else:
        raise HTTPException(status_code=400, detail="No dubbed audio track")

    bg_path = job.get("no_vocals_path")

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        if os.path.exists(vocals_path):
            zf.write(vocals_path, f"vocals_dubbed_{lang_label}.wav")
        if bg_path and os.path.exists(bg_path):
            zf.write(bg_path, "background_original.wav")

    zip_buffer.seek(0)
    base_name = os.path.splitext(job.get('filename', 'video'))[0]
    safe_name = ''.join(c for c in base_name if c.isalnum() or c in '-_ ').strip() or 'stems'
    return Response(
        content=zip_buffer.read(),
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(f"stems_{safe_name}.zip")},
    )
