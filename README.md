# Nauzunadub Studio

App desktop dubbing video tập trung 1 luồng duy nhất:

```
YouTube URL / file MP4  →  Transcribe (WhisperX)  →  Translate (LLM local hoặc cloud)
                       →  Re-voice (TTS, đổi giọng theo speaker)  →  Export MP4
```

Stack: **FastAPI backend + React/Vite/Tauri desktop frontend + SQLite** với 6 TTS engine pluggable (OmniVoice, CosyVoice 3, VoxCPM2, MLX-Audio, MOSS-TTS-Nano, KittenTTS). Clone gọn từ [OmniVoice-Studio](../OmniVoice-Studio), bỏ phần dictation/hotkey/MCP/marketplace/projects/glossary, bổ sung UI **Voice Settings** để đổi chất giọng từng speaker sau khi phân tích.

## Quickstart

```powershell
# Backend (Windows — dùng launcher để Proactor loop được tôn trọng kể cả khi --reload)
cd backend
uv sync
uv run python dev_server.py

# macOS / Linux — uvicorn CLI thuần là đủ
cd backend
uv sync
uv run uvicorn main:app --port 3900 --reload

# Frontend (terminal khác)
cd frontend
bun install
bun run dev
```

> **Tại sao cần `dev_server.py` trên Windows**: uvicorn 0.47+ với `--reload`
> hardcode `SelectorEventLoop` trên Windows (`use_subprocess=True`).
> `SelectorEventLoop` không hỗ trợ `asyncio.create_subprocess_exec` → ffmpeg/
> yt-dlp spawn fail với `NotImplementedError` rỗng. Launcher gọi uvicorn
> programmatic với `loop=ProactorEventLoop` để giải quyết.

## Cấu trúc

- `backend/api/routers/` — REST endpoints (dub_core, dub_transcribe, dub_translate, dub_voices, dub_generate, dub_export, profiles, engines, system)
- `backend/services/` — Business logic (ASR, TTS, dub pipeline, translator, ffmpeg, segmentation)
- `backend/core/` — Config, DB (SQLite), job queue, event bus, prefs
- `frontend/src/pages/` — DubTab, VoiceGallery, VoiceSettings, Settings
- `frontend/src-tauri/` — Tauri shell tối giản

## LLM Translation

Cấu hình LLM provider qua **Settings → LLM Provider** (lưu vào SQLite `app_prefs`):

- OpenAI: `base_url = https://api.openai.com/v1`, model `gpt-4o-mini`
- Ollama local: `base_url = http://localhost:11434/v1`, model `qwen2.5:7b`
- LM Studio: `base_url = http://localhost:1234/v1`, model do LM Studio expose
- OpenRouter: `base_url = https://openrouter.ai/api/v1`

## Trạng thái

Đang phát triển — xem `C:\Users\ADMIN\.claude\plans\parallel-bubbling-reddy.md` cho lộ trình 6 phase.
