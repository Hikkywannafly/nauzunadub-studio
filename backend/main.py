"""VideoDub Studio backend — slim FastAPI app focused on video dubbing pipeline.

Clone gọn từ OmniVoice-Studio: chỉ giữ luồng YouTube/file → transcribe → translate
→ re-voice → MP4. Bỏ dictation/hotkey, MCP, marketplace, projects, glossary, batch.
"""
import os
import sys

# Windows: ép ProactorEventLoopPolicy. Mặc định Python 3.8+ là Proactor,
# nhưng uvicorn --reload và một số lib (nest_asyncio, jupyter) có thể đảo
# về SelectorEventLoop — khi đó `asyncio.create_subprocess_exec` raises
# NotImplementedError với message rỗng, làm ffmpeg extract fail im lặng.
if sys.platform == "win32":
    import asyncio
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except AttributeError:
        pass  # Python < 3.7 hoặc non-Windows shim — bỏ qua.

# Ensure `backend/` is on sys.path so bare imports like `from core.config` work.
_backend_dir = os.path.dirname(os.path.abspath(__file__))
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

# Repo root chứa package `omnivoice/` (port từ OmniVoice-Studio). Phải nằm
# trên sys.path để `from omnivoice.models.omnivoice import OmniVoice` chạy
# được khi uvicorn chưa cài videodub-studio dạng editable.
_repo_root = os.path.dirname(_backend_dir)
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)

try:
    import dotenv
    dotenv.load_dotenv()
    _user_env = os.path.expanduser("~/.config/videodub/env")
    if os.path.isfile(_user_env):
        dotenv.load_dotenv(_user_env, override=False)
except ImportError:
    pass

# ── cuDNN 8 library preload (CTranslate2 / faster-whisper) ──────────────────
if sys.platform != "darwin":
    _project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if sys.platform == "win32":
        _cudnn8_lib = os.path.join(
            _project_root, ".venv", "Lib", "site-packages",
            "cudnn8_compat", "nvidia", "cudnn", "bin",
        )
        _cudnn8_glob = "cudnn*64_8.dll"
    else:
        _pyver = f"python{sys.version_info.major}.{sys.version_info.minor}"
        _cudnn8_lib = os.path.join(
            _project_root, ".venv", "lib", _pyver, "site-packages",
            "cudnn8_compat", "nvidia", "cudnn", "lib",
        )
        _cudnn8_glob = "libcudnn*.so.8"
    if os.path.isdir(_cudnn8_lib):
        try:
            import ctypes, glob
            _mode = 0 if sys.platform == "win32" else ctypes.RTLD_GLOBAL
            for _so in sorted(glob.glob(os.path.join(_cudnn8_lib, _cudnn8_glob))):
                try:
                    ctypes.CDLL(_so, mode=_mode)
                except OSError:
                    pass
        except Exception:
            pass

# Route HF/Torch caches when requested
_cache_dir = os.environ.get("VIDEODUB_CACHE_DIR") or os.environ.get("OMNIVOICE_CACHE_DIR")
if _cache_dir:
    os.makedirs(_cache_dir, exist_ok=True)
    os.environ["HF_HOME"] = _cache_dir
    os.environ["HF_HUB_CACHE"] = _cache_dir
    os.environ["TORCH_HOME"] = _cache_dir

if sys.platform == "win32":
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("TORCHAUDIO_USE_TORCHCODEC", "0")
sys.modules.setdefault("torchcodec", None)

import warnings
import logging
from logging.handlers import RotatingFileHandler
import torchaudio

warnings.filterwarnings("ignore", category=UserWarning)
torchaudio.set_audio_backend("soundfile")

_LOG_FMT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
logging.basicConfig(
    level=os.environ.get("VIDEODUB_LOG_LEVEL", "INFO"),
    format=_LOG_FMT,
)
logging.getLogger("huggingface_hub.utils._http").setLevel(logging.ERROR)
logging.getLogger("httpx").setLevel(logging.WARNING)
# Pyannote/Lightning spam cảnh báo version mismatch mỗi lần load checkpoint
# VAD — checkpoint cũ vẫn work cho inference, không cần spam.
logging.getLogger("pytorch_lightning.utilities.migration.utils").setLevel(logging.ERROR)
logging.getLogger("pyannote.audio.utils.version").setLevel(logging.ERROR)
import warnings as _warnings
_warnings.filterwarnings("ignore", message=".*Model was trained with.*")
_warnings.filterwarnings("ignore", message=".*pyannote.audio.*")

from core.config import LOG_PATH, CRASH_LOG_PATH, OUTPUTS_DIR, VOICES_DIR

if not os.environ.get("VIDEODUB_DISABLE_FILE_LOG"):
    try:
        _fh = RotatingFileHandler(LOG_PATH, maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8")
        _fh.setLevel(logging.INFO)
        _fh.setFormatter(logging.Formatter(_LOG_FMT))
        logging.getLogger().addHandler(_fh)
    except Exception as _e:
        logging.getLogger("videodub.api").warning("File log disabled: %s", _e)

logger = logging.getLogger("videodub.api")

import asyncio
import time
import threading
import traceback
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

_crash_log_lock = threading.Lock()

from core.db import init_db
from core import job_store
from core.tasks import task_manager
from services.model_manager import idle_worker, preload_model

# Routers kept for the dubbing-focused app
from api.routers import (
    system,
    profiles,
    exports,
    generation,
    dub_core,
    dub_generate,
    dub_export,
    dub_translate,
    engines,
    tools,
    watermark,
    events,
    openai_compat,
    tts_stream,
    setup,
    projects,
)
# dub_voices is added in Phase 3 — import guarded so Phase 1 boots cleanly.
try:
    from api.routers import dub_voices  # type: ignore
except ImportError:
    dub_voices = None

# prefs router (Phase 2) — same guard
try:
    from api.routers import prefs as prefs_router  # type: ignore
except ImportError:
    prefs_router = None

from utils import hf_progress
hf_progress.install()


@asynccontextmanager
async def lifespan(app: FastAPI):
    _loop_type = type(asyncio.get_running_loop()).__name__
    logger.info("Event loop: %s (need ProactorEventLoop on Windows for subprocess)", _loop_type)
    if sys.platform == "win32" and _loop_type != "ProactorEventLoop":
        logger.warning(
            "Windows + %s: asyncio.create_subprocess_exec sẽ raise NotImplementedError. "
            "Chạy backend bằng `uv run python dev_server.py` thay vì `uvicorn` CLI.",
            _loop_type,
        )
    init_db()
    try:
        swept = job_store.sweep_orphans_on_startup()
        if swept:
            logger.info("Startup: marked %d orphaned job(s) as failed.", swept)
    except Exception:
        logger.exception("Startup job-sweep failed (non-fatal).")

    idle_task = asyncio.create_task(idle_worker())
    worker_task = asyncio.create_task(task_manager.worker())
    preload_task = asyncio.create_task(preload_model())
    yield
    logger.info("Shutdown: cleaning up…")
    idle_task.cancel()
    worker_task.cancel()
    for t in (idle_task, worker_task):
        try:
            await asyncio.wait_for(t, timeout=3.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
    try:
        import services.model_manager as mm
        if mm.model is not None:
            mm.model = None
        mm.free_vram()
    except Exception:
        pass
    try:
        import gc
        gc.collect()
    except Exception:
        pass
    try:
        from api.http_client import close_http_client
        await close_http_client()
    except Exception:
        pass
    logger.info("Shutdown: done.")


app = FastAPI(
    title="VideoDub Studio API",
    version="0.1.0",
    lifespan=lifespan,
)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    exc_name = type(exc).__name__
    if exc_name in ("LocalProtocolError", "ClientDisconnect") or "Content-Length" in str(exc):
        logger.info("Client disconnect during %s (%s)", request.url, exc_name)
        return Response(status_code=499)
    try:
        with _crash_log_lock, open(CRASH_LOG_PATH, "a") as f:
            f.write(f"\n--- {time.strftime('%Y-%m-%dT%H:%M:%S')} ---\n")
            f.write(f"Request: {request.url}\n")
            f.write(traceback.format_exc())
    except Exception:
        logger.exception("Failed to write crash log")
    logger.exception("Unhandled exception for %s", request.url)
    origin = request.headers.get("origin", "")
    headers: dict[str, str] = {}
    if origin and (origin in _allowed or "*" in _allowed):
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
        headers["Vary"] = "Origin"
    return JSONResponse({"detail": str(exc)}, status_code=500, headers=headers)


_allowed = os.environ.get(
    "VIDEODUB_ALLOWED_ORIGINS",
    "http://localhost:3901,http://127.0.0.1:3901,tauri://localhost,http://tauri.localhost",
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _allowed if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

app.mount("/audio", StaticFiles(directory=OUTPUTS_DIR), name="audio")
app.mount("/voice_audio", StaticFiles(directory=VOICES_DIR), name="voice_audio")


@app.get("/health")
def health():
    import torch
    device = "cpu"
    if torch.cuda.is_available():
        device = f"cuda ({torch.cuda.get_device_name(0)})"
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = "mps"
    return {"status": "ok", "device": device, "app": "videodub-studio"}


app.include_router(system.router)
app.include_router(profiles.router)
app.include_router(exports.router)
app.include_router(generation.router)
app.include_router(dub_core.router)
app.include_router(dub_generate.router)
app.include_router(dub_export.router)
app.include_router(dub_translate.router)
app.include_router(engines.router)
app.include_router(tools.router)
app.include_router(watermark.router)
app.include_router(events.router)
app.include_router(openai_compat.router)
app.include_router(tts_stream.router)
app.include_router(setup.router)
app.include_router(projects.router)
if dub_voices is not None:
    app.include_router(dub_voices.router)
if prefs_router is not None:
    app.include_router(prefs_router.router)


frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")
else:
    @app.get("/")
    def _dev_fallback():
        return RedirectResponse(url="http://localhost:3901")


if __name__ == "__main__":
    import uvicorn
    # SECURITY: default to loopback. No auth on the API; binding to 0.0.0.0
    # by default would expose every router to any host on the user's LAN.
    # Docker images publish via host-side port mapping with OMNIVOICE_BIND_HOST=0.0.0.0.
    _bind_host = os.environ.get("OMNIVOICE_BIND_HOST", "127.0.0.1")
    uvicorn.run(app, host=_bind_host, port=3900)
