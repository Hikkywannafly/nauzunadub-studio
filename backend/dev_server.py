"""Dev launcher cho backend trên Windows.

uvicorn 0.47 + `--reload` trên Windows force `SelectorEventLoop` (vì
`use_subprocess=True`). SelectorEventLoop không hỗ trợ
`asyncio.create_subprocess_exec` → ffmpeg/yt-dlp spawn raise
`NotImplementedError` rỗng. Script này tránh CLI flag rắc rối bằng cách
truyền `loop` factory trực tiếp vào `uvicorn.Config`.

Dùng:
    cd backend
    uv run python dev_server.py
"""
from __future__ import annotations

import asyncio
import os
import sys

# Disable torch.compile / TorchDynamo trước khi torch được import bất cứ đâu
# trong app. Windows + CUDA không có Triton → torch.compile lazy-fail tại
# inference → TTS generate raise "Cannot find a working triton installation".
# Tauri build đã set sẵn trong src-tauri/src/backend.rs; dev server cũng phải.
os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
os.environ.setdefault("TORCH_COMPILE_DISABLE", "1")

import uvicorn

# Repo root chứa package `omnivoice/`. Add vào sys.path TRƯỚC khi uvicorn
# import main:app (tương ứng với logic trong main.py).
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_THIS_DIR)
for _p in (_THIS_DIR, _REPO_ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Child process spawn (uvicorn --reload trên Windows) KHÔNG kế thừa sys.path
# modifications runtime — chỉ kế thừa env. Set PYTHONPATH để child re-import
# được `main:app` + `_loop_factory:proactor_factory`.
_existing_pp = os.environ.get("PYTHONPATH", "")
_pp_parts = [_THIS_DIR, _REPO_ROOT]
if _existing_pp:
    _pp_parts.append(_existing_pp)
os.environ["PYTHONPATH"] = os.pathsep.join(_pp_parts)


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

    # Pass loop factory as STRING (not callable). Child process (spawned bởi
    # ChangeReload trên Windows) phải re-import được factory; nếu pass callable
    # từ __main__ nó sẽ unpickle fail và uvicorn fall back về SelectorEventLoop.
    config = uvicorn.Config(
        "main:app",
        host="127.0.0.1",
        port=int(os.environ.get("VIDEODUB_PORT", "3900")),
        reload=True,
        reload_dirs=[_THIS_DIR],
        loop="_loop_factory:proactor_factory",  # type: ignore[arg-type]
        log_level=os.environ.get("VIDEODUB_LOG_LEVEL", "info").lower(),
    )
    server = uvicorn.Server(config)
    server.run()
