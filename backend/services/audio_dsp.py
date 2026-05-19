"""
Audio DSP pipeline — broadcast-grade mastering + configurable effects chain.

The default `apply_mastering()` is the same chain shipped since v0.1.0
(highpass + compressor + light reverb). The new `apply_effects_chain()`
lets callers build custom pipelines from a list of named effects.

All effects use Spotify's `pedalboard` library. When pedalboard isn't
installed, every function degrades gracefully (returns audio unmodified).
"""
import logging
import torch

logger = logging.getLogger("omnivoice.dsp")

# ── Effect presets ──────────────────────────────────────────────────────

EFFECT_PRESETS = {
    "broadcast": {
        "label": "Broadcast",
        "icon": "📻",
        "description": "Radio/podcast standard — warm, compressed, clear.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 80},
            {"type": "compressor", "threshold_db": -18, "ratio": 3.0, "attack_ms": 5, "release_ms": 80},
            {"type": "eq", "low_gain_db": 1.5, "mid_gain_db": 0, "high_gain_db": 2.0},
            {"type": "limiter", "threshold_db": -1.0},
        ],
    },
    "cinematic": {
        "label": "Cinematic",
        "icon": "🎬",
        "description": "Film-quality — spacious reverb, gentle compression.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 60},
            {"type": "compressor", "threshold_db": -15, "ratio": 1.8, "attack_ms": 10, "release_ms": 150},
            {"type": "reverb", "room_size": 0.35, "wet_level": 0.15, "dry_level": 0.85},
            {"type": "limiter", "threshold_db": -1.5},
        ],
    },
    "podcast": {
        "label": "Podcast",
        "icon": "🎙️",
        "description": "Close-mic, intimate — heavy compression, no reverb.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 100},
            {"type": "noise_gate", "threshold_db": -40, "release_ms": 200},
            {"type": "compressor", "threshold_db": -20, "ratio": 4.0, "attack_ms": 2, "release_ms": 60},
            {"type": "eq", "low_gain_db": -1.0, "mid_gain_db": 2.0, "high_gain_db": 1.5},
            {"type": "limiter", "threshold_db": -0.5},
        ],
    },
    "raw": {
        "label": "Raw",
        "icon": "🔇",
        "description": "No processing — model output as-is.",
        "chain": [],
    },
    "warm": {
        "label": "Warm",
        "icon": "☀️",
        "description": "Boosted low-mids, subtle saturation, cozy feel.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 60},
            {"type": "eq", "low_gain_db": 3.0, "mid_gain_db": 1.0, "high_gain_db": -1.0},
            {"type": "compressor", "threshold_db": -16, "ratio": 2.0, "attack_ms": 8, "release_ms": 120},
            {"type": "reverb", "room_size": 0.15, "wet_level": 0.06, "dry_level": 0.94},
        ],
    },
    "bright": {
        "label": "Bright",
        "icon": "✨",
        "description": "Crisp high-end, presence boost, airy feel.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 80},
            {"type": "eq", "low_gain_db": -1.0, "mid_gain_db": 0, "high_gain_db": 4.0},
            {"type": "compressor", "threshold_db": -14, "ratio": 2.5, "attack_ms": 3, "release_ms": 80},
            {"type": "limiter", "threshold_db": -1.0},
        ],
    },
}


def list_effect_presets() -> list[dict]:
    """Return presets for the frontend UI picker."""
    return [
        {"id": k, "label": v["label"], "icon": v["icon"], "description": v["description"]}
        for k, v in EFFECT_PRESETS.items()
    ]


def get_effect_chain(preset_id: str) -> list[dict]:
    """Return the effect chain for a preset. Falls back to empty chain."""
    p = EFFECT_PRESETS.get(preset_id)
    return p["chain"] if p else []


# ── Core DSP functions ──────────────────────────────────────────────────


# ── Audio profile presets ─────────────────────────────────────────────────
# Mỗi profile = bộ tham số DSP + normalize phù hợp 1 loại content.
# - cinematic   : drama/phim — giữ dynamic range (whisper vs shout)
# - broadcast   : vlog/postcast — đều như phát sóng, compress vừa phải
# - voiceover   : narrator/tutorial — phẳng, ổn định nhất
# - natural     : raw TTS, không xử lý — user tự post-process sau
AUDIO_PROFILES = {
    "cinematic": {
        "label": "Cinematic (phim drama)",
        "description": "Giữ dynamic range — whisper vẫn ra whisper, shout vẫn shout",
        "mastering": {
            "hpf_hz": 60,
            "compressor": {"threshold_db": -22, "ratio": 1.2, "attack_ms": 5.0, "release_ms": 200},
            "reverb": {"room_size": 0.12, "wet_level": 0.06, "dry_level": 0.95},
        },
        # RMS target thấp + cap chặt → tôn trọng dynamics tự nhiên
        "normalize": {"target_dBFS": -16.0, "max_gain_db": 3.0, "min_gain_db": -3.0},
    },
    "broadcast": {
        "label": "Broadcast (vlog / postcast)",
        "description": "Đều như phát thanh, compress vừa — phù hợp đa số nội dung",
        # Tuned back toward the legacy OmniVoice-Studio settings: lower comp
        # ratio preserves consonant punch ("k/t/p" stay crisp), louder RMS
        # target stops the voice sounding far away. Cap is wide enough that
        # the gain stage actually reaches target on quiet TTS output.
        "mastering": {
            "hpf_hz": 60,
            "compressor": {"threshold_db": -15, "ratio": 1.5, "attack_ms": 2.0, "release_ms": 100},
            "reverb": {"room_size": 0.10, "wet_level": 0.08, "dry_level": 0.95},
        },
        "normalize": {"target_dBFS": -4.0, "max_gain_db": 12.0, "min_gain_db": -10.0},
    },
    "voiceover": {
        "label": "Voiceover (narrator / tutorial)",
        "description": "Phẳng, ổn định nhất — compress mạnh, mọi câu cùng level",
        "mastering": {
            "hpf_hz": 80,
            "compressor": {"threshold_db": -12, "ratio": 3.0, "attack_ms": 1.0, "release_ms": 80},
            "reverb": {"room_size": 0.05, "wet_level": 0.04, "dry_level": 0.98},
        },
        "normalize": {"target_dBFS": -9.0, "max_gain_db": 10.0, "min_gain_db": -10.0},
    },
    "natural": {
        "label": "Natural (raw, không xử lý)",
        "description": "Để raw TTS output — user tự post-process sau",
        "mastering": None,  # skip
        "normalize": None,  # skip
    },
}


def get_audio_profile(profile_name: str | None) -> dict:
    """Lookup profile by name, fallback về broadcast nếu None/invalid."""
    if not profile_name:
        return AUDIO_PROFILES["broadcast"]
    return AUDIO_PROFILES.get(profile_name, AUDIO_PROFILES["broadcast"])


def list_audio_profiles() -> list[dict]:
    """For API endpoint listing profiles cho frontend dropdown."""
    return [
        {"id": pid, "label": p["label"], "description": p["description"]}
        for pid, p in AUDIO_PROFILES.items()
    ]


def apply_mastering(audio_tensor, sample_rate=24000, profile: str | None = None):
    """Applies DSP (EQ, Compressor, light Reverb) theo profile audio chọn.

    profile=None → fallback "broadcast" (vlog/postcast).
    profile="natural" → no-op, trả nguyên audio tensor.
    """
    cfg = get_audio_profile(profile)
    m = cfg.get("mastering")
    if m is None:
        return audio_tensor  # natural profile: skip mastering
    try:
        from pedalboard import Pedalboard, Compressor, Reverb, HighpassFilter
        import numpy as np
        comp = m["compressor"]
        rev = m["reverb"]
        board = Pedalboard([
            HighpassFilter(cutoff_frequency_hz=m["hpf_hz"]),
            Compressor(threshold_db=comp["threshold_db"], ratio=comp["ratio"],
                       attack_ms=comp["attack_ms"], release_ms=comp["release_ms"]),
            Reverb(room_size=rev["room_size"], wet_level=rev["wet_level"], dry_level=rev["dry_level"])
        ])
        audio_np = audio_tensor.cpu().numpy()
        if audio_np.ndim == 1:
            audio_np = audio_np[np.newaxis, :]
        effected = board(audio_np, sample_rate, reset=False)
        return torch.from_numpy(effected).to(audio_tensor.device)
    except ImportError:
        return audio_tensor # Fail gracefully if pedalboard isn't installed
    except Exception as e:
        logger.warning("Mastering DSP Error: %s", e)
        return audio_tensor


def normalize_audio(audio_tensor, target_dBFS=-2.0, profile: str | None = None):
    """Normalize loudness theo 2 mode:

    - `profile=None` (legacy): peak-normalize tới `target_dBFS` (default -2 dBFS).
      Giữ nguyên behavior cũ cho callers chưa migrate (gpu_sandbox, batched_tts,
      tts_stream, openai_compat, generation).
    - `profile="<name>"`: RMS-based normalize tới target từ profile config, có
      gain cap ± và soft clip. Dùng cho dub pipeline (DubRequest.audio_profile).
      `profile="natural"` → no-op.
    """
    if audio_tensor.numel() == 0:
        return audio_tensor

    # Legacy path: peak-normalize. Caller không truyền profile → giữ hành vi cũ
    # để không phá output của các route khác (TTS stream, OpenAI compat, etc.).
    if profile is None:
        max_val = torch.abs(audio_tensor).max()
        if max_val > 0:
            target_amp = 10 ** (target_dBFS / 20.0)
            audio_tensor = audio_tensor * (target_amp / max_val)
        return audio_tensor

    # Profile-driven RMS path
    cfg = get_audio_profile(profile)
    norm_cfg = cfg.get("normalize")
    if norm_cfg is None:
        return audio_tensor  # natural: skip normalize
    target_dBFS = norm_cfg["target_dBFS"]
    max_gain_db = norm_cfg["max_gain_db"]
    min_gain_db = norm_cfg["min_gain_db"]

    # RMS đo perceived loudness chính xác hơn peak nhiều.
    rms = torch.sqrt(torch.mean(audio_tensor ** 2))
    if rms < 1e-6:
        return audio_tensor  # silence — không boost noise floor
    target_amp = 10 ** (target_dBFS / 20.0)
    gain = target_amp / rms
    gain = float(torch.clamp(
        torch.tensor(float(gain)),
        10 ** (min_gain_db / 20.0),
        10 ** (max_gain_db / 20.0),
    ))
    audio_tensor = audio_tensor * gain
    # Soft clip phòng peak overshoot sau gain
    if audio_tensor.abs().max() > 0.98:
        audio_tensor = torch.tanh(audio_tensor * 0.95) / 0.95
    return audio_tensor


def apply_effects_chain(audio_tensor, sample_rate: int, chain: list[dict]) -> torch.Tensor:
    """Apply a chain of named effects to an audio tensor.

    Each item in `chain` is a dict with a `type` key and effect-specific
    parameters. Unknown types are silently skipped.

    Supported types:
        highpass    — cutoff_hz (default 80)
        lowpass     — cutoff_hz (default 8000)
        compressor  — threshold_db, ratio, attack_ms, release_ms
        reverb      — room_size, wet_level, dry_level
        noise_gate  — threshold_db, release_ms
        eq          — low_gain_db, mid_gain_db, high_gain_db
        limiter     — threshold_db
    """
    if not chain:
        return audio_tensor

    try:
        from pedalboard import (
            Pedalboard,
            Compressor,
            Reverb,
            HighpassFilter,
            LowpassFilter,
            NoiseGate,
            Limiter,
            LowShelfFilter,
            HighShelfFilter,
            PeakFilter,
        )
        import numpy as np
    except ImportError:
        logger.debug("pedalboard not installed — effects chain skipped")
        return audio_tensor

    plugins = []
    for fx in chain:
        t = fx.get("type", "").lower()
        try:
            if t == "highpass":
                plugins.append(HighpassFilter(cutoff_frequency_hz=fx.get("cutoff_hz", 80)))
            elif t == "lowpass":
                plugins.append(LowpassFilter(cutoff_frequency_hz=fx.get("cutoff_hz", 8000)))
            elif t == "compressor":
                plugins.append(Compressor(
                    threshold_db=fx.get("threshold_db", -15),
                    ratio=fx.get("ratio", 2.0),
                    attack_ms=fx.get("attack_ms", 5),
                    release_ms=fx.get("release_ms", 100),
                ))
            elif t == "reverb":
                plugins.append(Reverb(
                    room_size=fx.get("room_size", 0.2),
                    wet_level=fx.get("wet_level", 0.1),
                    dry_level=fx.get("dry_level", 0.9),
                ))
            elif t == "noise_gate":
                plugins.append(NoiseGate(
                    threshold_db=fx.get("threshold_db", -40),
                    release_ms=fx.get("release_ms", 200),
                ))
            elif t == "limiter":
                plugins.append(Limiter(threshold_db=fx.get("threshold_db", -1.0)))
            elif t == "eq":
                low = fx.get("low_gain_db", 0)
                mid = fx.get("mid_gain_db", 0)
                high = fx.get("high_gain_db", 0)
                if low:
                    plugins.append(LowShelfFilter(cutoff_frequency_hz=250, gain_db=low))
                if mid:
                    plugins.append(PeakFilter(cutoff_frequency_hz=1500, gain_db=mid, q=1.0))
                if high:
                    plugins.append(HighShelfFilter(cutoff_frequency_hz=4000, gain_db=high))
            else:
                logger.debug("Unknown effect type: %s — skipped", t)
        except Exception as e:
            logger.warning("Failed to create %s effect: %s", t, e)

    if not plugins:
        return audio_tensor

    board = Pedalboard(plugins)
    audio_np = audio_tensor.cpu().numpy()
    if audio_np.ndim == 1:
        audio_np = audio_np[None, :]
    try:
        effected = board(audio_np, sample_rate, reset=False)
        return torch.from_numpy(effected).to(audio_tensor.device)
    except Exception as e:
        logger.warning("Effects chain failed: %s — returning unmodified audio", e)
        return audio_tensor

