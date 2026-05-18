# VideoDub Studio — Verification Checklist

Chạy theo thứ tự sau khi clone xong xuôi.

## 1. Backend smoke

```powershell
cd D:\VoiceClone\videodub-studio
uv sync                          # ~5-15 phút lần đầu (torch + cuda + whisperx)
cd backend
uv run uvicorn main:app --port 3900 --reload
```

Mở `http://127.0.0.1:3900/health` → kỳ vọng `{"status":"ok","device":"cuda (...)" hoặc "cpu","app":"videodub-studio"}`.

Health check endpoints khác:
- `GET /api/prefs` → trả `{llm_base_url, llm_model, llm_api_key_set, target_lang, tts_backend, asr_backend}`
- `GET /engines/tts` → list 6 TTS engines (`omnivoice`, `cosyvoice3`, `voxcpm2`, …)

## 2. Frontend smoke

```powershell
cd D:\VoiceClone\videodub-studio\frontend
bun install                      # ~1-2 phút
bun run dev                      # Vite dev @ http://localhost:3901
```

Mở `http://localhost:3901` — sidebar/launchpad sẽ hiện. Nếu có lỗi do thiếu các page bị bỏ (BatchQueue, Projects, …) → xem `INTEGRATION_NOTES.md` mục 3 để xoá route.

## 3. Tauri desktop

```powershell
cd D:\VoiceClone\videodub-studio\frontend
bun run desktop                  # tauri dev
```

Cửa sổ desktop mở. Tau bắt đầu sidecar backend tự động.

## 4. End-to-end dubbing flow

1. Settings → **LLM Provider** → chọn preset Ollama → bấm **Test kết nối** → kỳ vọng OK ms.
2. DubTab → paste YouTube URL ngắn (≤ 60s, ví dụ TED clip) → **Ingest**.
3. Đợi Transcribe xong → segments hiện với `Speaker 1`, `Speaker 2`.
4. Translate sang `vi` → kiểm tra text dịch xuất hiện.
5. **VoiceSettings** → gán:
   - Speaker 1 → profile A, engine OmniVoice
   - Speaker 2 → profile B, engine CosyVoice 3
   - Bấm Preview từng cái → nghe sample.
6. Generate → đợi TTS xong → check MP4 export.
7. Test partial regenerate: chọn 1 segment, đổi text, bấm **Regenerate** → chỉ segment đó thay đổi.

## 5. Unit tests (optional)

```powershell
cd D:\VoiceClone\videodub-studio
uv run pytest backend/tests -k "dub_pipeline or tts_backend or segmentation"
```

## Troubleshooting

- **WhisperX báo cuDNN missing** trên Windows → chạy `python scripts\setup_cudnn.py` (copy từ OmniVoice repo gốc nếu cần).
- **HF token cần** cho pyannote diarization → set env `HF_TOKEN=hf_...` hoặc dùng UI Settings → HF Token (nếu đã ghép).
- **LLM test fail với Ollama** → đảm bảo Ollama đang chạy + model đã pull: `ollama pull qwen2.5:7b`.
- **OmniVoice TTS không khả dụng** → tạm thời dùng KittenTTS (turbo English) hoặc CosyVoice. Cài `pip install omnivoice` riêng nếu cần.
