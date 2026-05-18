import os
import sys


def get_app_data_dir():
    """Resolve user data directory. Honors VIDEODUB_DATA_DIR first, then legacy OMNIVOICE_DATA_DIR."""
    custom_dir = os.environ.get("VIDEODUB_DATA_DIR") or os.environ.get("OMNIVOICE_DATA_DIR")
    if custom_dir:
        return custom_dir
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/VideoDubStudio")
    elif sys.platform == "win32":
        return os.path.join(os.environ.get("APPDATA", ""), "VideoDubStudio")
    else:
        return os.path.expanduser("~/.videodub-studio")


def _ensure_short_hf_cache_on_windows():
    if sys.platform != "win32":
        return
    if os.environ.get("VIDEODUB_CACHE_DIR") or os.environ.get("OMNIVOICE_CACHE_DIR") \
            or os.environ.get("HF_HOME") or os.environ.get("HF_HUB_CACHE"):
        return
    local_app = os.environ.get("LOCALAPPDATA", "")
    if not local_app:
        return
    short_cache = os.path.join(local_app, "VideoDubStudio", "hf_cache")
    os.makedirs(short_cache, exist_ok=True)
    os.environ["HF_HOME"] = short_cache
    os.environ["HF_HUB_CACHE"] = short_cache


_ensure_short_hf_cache_on_windows()

DATA_DIR = get_app_data_dir()
VOICES_DIR = os.path.join(DATA_DIR, "voices")
OUTPUTS_DIR = os.path.join(DATA_DIR, "outputs")
DUB_DIR = os.path.join(DATA_DIR, "dub_jobs")
DB_PATH = os.path.join(DATA_DIR, "videodub.db")
PREVIEW_DIR = os.path.join(DATA_DIR, "preview")
CRASH_LOG_PATH = os.path.join(DATA_DIR, "crash_log.txt")
LOG_PATH = os.path.join(DATA_DIR, "videodub.log")

IDLE_TIMEOUT_SECONDS = int(os.environ.get("VIDEODUB_IDLE_TIMEOUT", os.environ.get("OMNIVOICE_IDLE_TIMEOUT", "900")))
CPU_POOL_WORKERS = int(os.environ.get("VIDEODUB_CPU_POOL", "0")) or min(8, (os.cpu_count() or 4))

# LLM defaults — overridable per-request via app_prefs (see core/prefs.py)
DEFAULT_LLM_BASE_URL = os.environ.get("VIDEODUB_LLM_BASE_URL", "https://api.openai.com/v1")
DEFAULT_LLM_MODEL = os.environ.get("VIDEODUB_LLM_MODEL", "gpt-4o-mini")
DEFAULT_LLM_API_KEY = os.environ.get("VIDEODUB_LLM_API_KEY", os.environ.get("OPENAI_API_KEY", ""))


def ensure_dirs():
    for d in [DATA_DIR, VOICES_DIR, OUTPUTS_DIR, DUB_DIR, PREVIEW_DIR]:
        os.makedirs(d, exist_ok=True)


ensure_dirs()

if sys.platform != "win32":
    for _fpath in ["/opt/homebrew/bin", "/usr/local/bin"]:
        if _fpath not in os.environ.get("PATH", "") and os.path.exists(_fpath):
            os.environ["PATH"] = _fpath + os.pathsep + os.environ.get("PATH", "")
