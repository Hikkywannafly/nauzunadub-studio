"""Custom asyncio loop factory để workaround uvicorn --reload trên Windows.

uvicorn 0.47+ trên Windows: khi `--reload` (hoặc `--workers > 1`), `Config.use_subprocess`
trả True, và `asyncio_loop_factory(use_subprocess=True)` trả `SelectorEventLoop` thay vì
`ProactorEventLoop`. `SelectorEventLoop` không hỗ trợ `asyncio.create_subprocess_exec`
→ ffmpeg / yt-dlp spawn raise `NotImplementedError` với empty message.

Dùng:
    uv run uvicorn main:app --port 3900 --reload --loop _loop_factory:proactor_factory
"""
from __future__ import annotations

import asyncio
import sys


def proactor_factory() -> asyncio.AbstractEventLoop:
    """Trả ProactorEventLoop trên Windows, SelectorEventLoop ở nơi khác."""
    if sys.platform == "win32":
        return asyncio.ProactorEventLoop()
    return asyncio.new_event_loop()
