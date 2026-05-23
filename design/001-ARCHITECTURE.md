# 001 — Architecture: Pipeline Dubbing Video

> Tài liệu kiến trúc tổng quan cho luồng dubbing end-to-end của VideoDub Studio.
> Cập nhật: 2026-05-23.

---

## 🎬 6 Giai đoạn chính

```
┌────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌────────────┐
│ 1. INGEST  │──▶│ 2. TRANSCRIBE│──▶│  3.TRANSLATE │──▶│   4. EDIT    │──▶│  5. GENERATE │──▶│ 6. EXPORT  │
│  (upload)  │   │   (ASR+diar) │   │     (LLM)    │   │  (user fix)  │   │  (TTS + mix) │   │ (mux/sub)  │
└────────────┘   └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘   └────────────┘
     SSE              SSE             POST + snap         POST debounce         SSE              FileResponse
```

---

## 📦 Giai đoạn 1 — INGEST  *(`dub_pipeline.py :: ingest_pipeline`)*

```
  ┌─ POST /dub/upload         ─┐
  │  POST /dub/ingest-url      │──▶ task_manager.add_task("prep_{job_id}")
  └────────────────────────────┘
                                       │
                                       ▼
  ╔═══════════════════════════════════════════════════════╗
  ║  yt-dlp (URL)  →  ffmpeg 16k mono WAV  →  SHA-256     ║
  ║                                            │           ║
  ║                          ┌─────────────────┴─────┐    ║
  ║                          ▼                        ▼   ║
  ║               🟢 Cache hit                  🔴 Miss   ║
  ║       (copy artifact cũ)            ┌──────────────┐  ║
  ║                                     │ Demucs vocals│  ║
  ║                                     │ FFmpeg scenes│  ║
  ║                                     │ Thumbnail    │  ║
  ║                                     └──────────────┘  ║
  ╚═══════════════════════════════════════════════════════╝
                                       │
                                       ▼  SSE event: ready
                          Job state: vocals_path, no_vocals_path,
                                     scene_cuts, duration, thumb
```

**Sự kiện SSE:** `download_start` → `download_done` → `extract_start` → `extract_done` → `demucs_start` → `demucs_done` → `scene_start` → `scene_done` → `ready` (hoặc `cached` nếu hit).

**Cache key:** SHA-256 của file audio 16k mono đã extract. Khi hit, reuse `vocals.wav` / `no_vocals.wav` / `scene_cuts` / `thumb` từ job cũ — tiết kiệm vài chục giây Demucs cho mỗi lần re-upload cùng nguồn.

---

## 📝 Giai đoạn 2 — TRANSCRIBE  *(`dub_core.py :: dub_transcribe_stream`)*

```
GET /dub/transcribe-stream/{job_id}   (Server-Sent Events)

  audio.wav ─┐
             ▼
  ┌──────────────────────────────────────────────────────┐
  │  Chia chunk 30 giây                                  │
  │  ▶ for each chunk:                                   │
  │      ├─ asr_backend.transcribe()                     │
  │      │    (WhisperX / faster-whisper / mlx / pytorch)│
  │      ├─ segment_transcript() + scene_cuts            │
  │      └─ SSE "segments" event (UI render dần)         │
  └──────────────────────────────────────────────────────┘
             │
             ▼
  ┌──────────────────────────────────────────────────────┐
  │  Pyannote diarization (cần HF_TOKEN)                 │
  │      ├─ Có  → assign_speakers_from_diarization()     │
  │      └─ Không → fallback silence-gap heuristic       │
  └──────────────────────────────────────────────────────┘
             │
             ▼
  ┌──────────────────────────────────────────────────────┐
  │  speaker_clone.extract_speaker_clones()              │
  │      → mỗi Speaker_N nhận 1 ref audio + ref text     │
  │      → segment.profile_id = "auto:speaker_N"         │
  │      ⚡ Đây là điểm khác biệt: dub giữ giọng gốc     │
  └──────────────────────────────────────────────────────┘
             │
             ▼  SSE event: final  →  Job: segments[], speaker_clones{}
```

**Pre-flight check:** lỗi (job not found / no audio / ASR not ready) phát qua SSE `error` event thay vì HTTP 5xx, vì EventSource không đọc được response body của non-2xx.

**TTS offload:** trước khi chạy WhisperX, gọi `offload_tts_for_asr()` để move TTS model sang CPU nếu free VRAM < 4 GB. Sau khi diarize xong, `restore_tts_after_asr()` đưa về GPU.

---

## 🌐 Giai đoạn 3 — TRANSLATE  *(`dub_translate.py`)*

```
POST /dub/translate/{job_id}
  {target_lang, genre, glossary, engine}

       ┌────────────────────────────────────┐
       │  Provider router (translator.py)   │
       │   ├─ Cinematic LLM (refine_many)   │
       │   ├─ OpenAI / Ollama / LM Studio   │
       │   ├─ NLLB / Google Translate       │
       │   └─ YouTube auto-subs (nếu có)    │
       └────────────────────────────────────┘
                       │
                       ▼
       ┌────────────────────────────────────┐
       │  Validation                        │
       │   ├─ Script block (Hindi/Thai…)    │
       │   ├─ Glossary enforcement          │
       │   └─ Retry với Retry-After parser  │
       └────────────────────────────────────┘
                       │
                       ▼
       Snapshot lưu vào job (cap 10 bản) → UI có thể undo
```

**Concurrency:** mặc định 2 request LLM song song (an toàn cho Ollama/LM Studio). Tăng qua env `VIDEODUB_LLM_TRANSLATE_CONCURRENCY=10+` khi dùng OpenAI cloud.

**Script enforcement:** mỗi ngôn ngữ target gắn 1 Unicode block bắt buộc (Hindi=Devanagari, Thai=Thai, …). Nếu output có <50% ký tự thuộc block → retry. Tránh trường hợp LLM nhỏ trả về Latin phiên âm cho `hi` / `de`.

---

## ✂️  Giai đoạn 4 — EDIT  *(`DubTab.jsx` + `DubSegmentTable`)*

```
  ┌─────────────────────────────────────────────────────┐
  │  User thao tác trên timeline:                       │
  │                                                     │
  │    • Sửa text          • Split / Merge segment     │
  │    • Đổi voice profile • Set direction (taxonomy)  │
  │    • Adjust speed/gain • Bulk delete / apply       │
  │    • Optimize LLM      • Timeline rebalance        │
  └─────────────────────────────────────────────────────┘
                       │ debounced
                       ▼
            POST /dub/segments/{job_id}
            (đồng bộ ngược về job["segments"])
```

**Auto-fix:** rebalance timeline + LLM batch optimize chạy 1 nút — chỉnh slot quá ngắn/dài về CPS chấp nhận được.

**Direction taxonomy** (xem `services/director.py`): user gõ tự nhiên ("urgent, surprised") → parser map vào 5 dimension cố định (`energy / emotion / pace / intimacy / formality`). LLM parser có fallback heuristic keyword.

---

## 🔊 Giai đoạn 5 — GENERATE  *(`dub_generate.py`)*

```
POST /dub/generate/{job_id}  → task_id  → SSE stream

╔═══════════════════════ TTS LOOP (mỗi segment) ═══════════════════════╗
║                                                                      ║
║  ┌─ Resolve voice ─────────────────────────────────────────────┐    ║
║  │  profile_id "auto:..."  → speaker_clones                    │    ║
║  │  profile_id "..."       → voice_profiles (DB)               │    ║
║  └─────────────────────────────────────────────────────────────┘    ║
║                              │                                       ║
║  ┌─ Pre-TTS tuning ──────────┼─────────────────────────────────┐    ║
║  │  director.parse(text) → instruct + rate_bias                │    ║
║  │  speech_rate slot_factor → speed nudge (±15%)               │    ║
║  └─────────────────────────────────────────────────────────────┘    ║
║                              │                                       ║
║                              ▼                                       ║
║  ┌─ TTS sinh audio ────────────────────────────────────────────┐    ║
║  │   _model.generate(text, ref_audio, instruct, speed, ...)    │    ║
║  │      num_step = 8 nếu preview, 32 nếu final                 │    ║
║  │      OOM retry với num_step thấp hơn                        │    ║
║  └─────────────────────────────────────────────────────────────┘    ║
║                              │                                       ║
║  ┌─ Post-process ────────────┼─────────────────────────────────┐    ║
║  │  apply_mastering(audio_profile) → normalize_audio           │    ║
║  │  (optional) RVC voice conversion                            │    ║
║  │  embed_watermark                                            │    ║
║  └─────────────────────────────────────────────────────────────┘    ║
║                              │                                       ║
║                              ▼                                       ║
║              seg_i.wav (batched flush sau loop)                      ║
║                                                                      ║
║  💡 Partial regen: nếu seg_id ∉ regen_only → load cache              ║
╚══════════════════════════════════════════════════════════════════════╝
                              │
                              ▼
╔═══════════════════════ MIX LOOP (assemble timeline) ═════════════════╗
║                                                                      ║
║   3 chế độ pacing:                                                   ║
║   ┌──────────────┬─────────────────────────────────────────────┐    ║
║   │  fit_slot    │ Ép audio vào slot gốc (time_stretch/trim)   │    ║
║   │  natural     │ Đọc tốc độ tự nhiên, anchor = seg.start     │    ║
║   │  sequential  │ Nếu seg N tràn → đẩy seg N+1 lùi            │    ║
║   └──────────────┴─────────────────────────────────────────────┘    ║
║                                                                      ║
║   + tail_allowance (cho phép tail bleed 250ms vào gap)               ║
║   + start_fade 15ms / end_fade 50ms                                  ║
║   + per-segment gain                                                 ║
║                                                                      ║
║   → dubbed_{lang_code}.wav  + 2nd watermark                          ║
╚══════════════════════════════════════════════════════════════════════╝
```

**Batched disk-write:** trong vòng lặp TTS, không ghi WAV ngay; collect vào `_pending_seg_writes` và flush 1 lượt sau khi GPU loop xong → cắt ~200 ms/seg I/O khỏi critical path.

**Partial regen (`regen_only`):** chỉ chạy TTS cho segment đã sửa; segment còn lại load `seg_i.wav` cũ. Primitive cốt lõi của trải nghiệm editor.

---

## 📤 Giai đoạn 6 — EXPORT  *(`dub_export.py`)*

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   GET /dub/preview-video  →  ffmpeg amix (BG 0.8 + Dub 1.2) │
│   GET /dub/download       →  MP4 hoàn chỉnh (mux video+dub) │
│   GET /dub/srt | /dub/vtt →  Subtitle với cue splitting     │
│   POST burn-in            →  ASS subtitle nướng vào video   │
│                              (PlayResY scale chính xác)     │
│   GET /dub/export-stems   →  Tách track (vocals / bg / dub) │
│   GET /dub/download-mp3   →  Audio-only export              │
│                                                             │
│   Tauri: _native_save() copy ra path do user chọn          │
└─────────────────────────────────────────────────────────────┘
```

**Cache preview-video:** mỗi tổ hợp `lang + preserve_bg` cache 1 MP4 ở `exports/preview_{lang}_{bg}.mp4`. Invalidate khi mtime của dub track mới hơn cache.

**Burn-in ASS:** dùng PlayResY scaled theo chiều cao video để FontSize render đúng size như preview (xem [[burn_subs_playresy]] — SRT path từng làm font phình 6×).

---

## 🗄️ State & Persistence

```
┌────────────────────────────────────────────────────────────┐
│              In-Memory                                     │
│   _dub_jobs[job_id] = {                                    │
│      video_path, audio_path, vocals_path, no_vocals_path,  │
│      segments[], speaker_clones{}, scene_cuts[],           │
│      dubbed_tracks{lang: path},                            │
│      seg_hashes{}, seg_num_step{},                         │
│      translation_snapshots[], timeline_snapshots[]         │
│   }                                                        │
└────────────────────────────────────────────────────────────┘
                          │  save_job() (mirror toàn bộ)
                          ▼
┌────────────────────────────────────────────────────────────┐
│              SQLite — dub_history                          │
│   id | filename | duration | segments_count |              │
│   language | tracks | job_data (JSON blob) | content_hash  │
└────────────────────────────────────────────────────────────┘

Frontend:  Zustand dubSlice  ←→  SSE events  ←→  Backend job state
```

**Resume sau reload:** `/tasks/stream/{task_id}?after_seq=N` replay event đã persist > N rồi attach vào in-memory listener. Reload giữa job vẫn thấy final state.

---

## ⚙️ Subsystem map

```
                                ┌───────────────────┐
                                │  model_manager    │
                                │  _gpu_pool        │
                                │  _cpu_pool        │
                                │  TTS/ASR offload  │
                                └─────────┬─────────┘
                                          │
   ┌────────────┬────────────┬────────────┼────────────┬────────────┐
   │            │            │            │            │            │
┌──▼───┐   ┌────▼────┐   ┌───▼──┐    ┌────▼───┐   ┌────▼────┐  ┌───▼────┐
│ ASR  │   │  Diariz │   │ LLM  │    │  TTS   │   │  Audio  │  │ FFmpeg │
│ back │   │ pyannote│   │ back │    │  F5/...│   │   DSP   │  │  utils │
└──────┘   └─────────┘   └──────┘    └────────┘   └─────────┘  └────────┘
WhisperX                  OpenAI      Speaker     mastering    semaphore
faster                    Ollama      clone       normalize    retry
mlx                       LMStudio    RVC         watermark    scene
pytorch                   Cinematic   Director
```

---

## ✅ Điểm mạnh

- **Phase split sạch:** `dub_pipeline.py` tách business logic khỏi router → callable từ Tools page / CLI / tests.
- **Content-hash cache:** reuse Demucs + scene cuts khi re-upload cùng nguồn.
- **SSE resumable:** reload giữa job không mất state.
- **Partial regen:** chỉ render lại segment đã sửa — primitive đúng cho editor UX.
- **Auto speaker clone:** mỗi speaker tự động có ref audio → cross-lingual dub giữ giọng gốc. Đây là điểm khác biệt cốt lõi.
- **Director taxonomy:** stable contract, LLM chỉ là 1 parser; có heuristic fallback offline.
- **Backend pluggable:** ASR / LLM / TTS / Translation đều có nhiều backend, dễ swap.

## ⚠️ Rủi ro / Điểm yếu

1. **Persistence "fat blob":** `_save_job` rewrite toàn bộ `job_data` JSON cho mọi edit. 200+ segment sẽ bít cổ.
2. **`dub_core.py` còn ôm transcribe SSE 790 dòng** — Phase 2.4 mới tách ingest. Cần tách tiếp `transcribe_pipeline`.
3. **`dub_generate` không register vào `_active_procs`** — `/dub/abort` kill được ffmpeg/demucs nhưng không kill được CUDA kernel đang chạy giữa segment.
4. **Không có mutex per-job** — Generate + Translate đồng thời ghi `job["segments"]`, later wins.
5. **`_resample_to` là linear interp** → pitch-shift ở `slot_factor_max=1.25`. Nên swap sang phase-vocoder.
6. **Watermark embed 2 lần** (per-seg + final). Nếu cố ý, cần comment; nếu không, bỏ 1.
7. **Translate concurrency mặc định 2** chậm cho cloud. Auto-detect và bump → 10 khi dùng OpenAI.
8. **`_dub_jobs` không evict** — server long-running = RSS leak. Cần LRU cap ~32 jobs.
9. **`dubSlice` monolithic** — ~20 setters trộn pipeline + content + options. Tách `dubMixSlice` riêng cho generation knobs.

## 🎯 Đề xuất ưu tiên

1. Extract `transcribe_pipeline` ra khỏi `dub_core.py` (mirror cách đã làm với ingest). Unblock tests cho generator dài nhất.
2. LRU-cap `_dub_jobs` + asyncio lock per job_id cho writes.
3. Swap `_resample_to` → phase-vocoder. Win quality cao nhất không cần retrain gì.
4. Register dub_generate task vào `_active_procs` để `/dub/abort` thật sự cắt được TTS.