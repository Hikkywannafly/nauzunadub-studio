import os
import re
import time
import random
import asyncio
import logging
from typing import Optional
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from schemas.requests import TranslateRequest
from services.model_manager import _cpu_pool, _gpu_pool
from services.translator import cinematic_available, cinematic_refine_many
from api.routers.dub_core import _get_job

router = APIRouter()
logger = logging.getLogger("omnivoice.api")

# Concurrency cap cho LLM translate. Endpoint OpenAI cloud chấp 10-20 song song
# thoải mái, nhưng LLM tự host (Ollama, LM Studio, custom proxy) thường rate-
# limit chặt — 13 segments fire cùng lúc → 429. Mặc định 2 cho an toàn. Tăng
# qua VIDEODUB_LLM_TRANSLATE_CONCURRENCY khi xài cloud endpoint.
_LLM_CONCURRENCY = max(1, int(os.environ.get("VIDEODUB_LLM_TRANSLATE_CONCURRENCY", "2")))
_LLM_MAX_RETRIES = max(0, int(os.environ.get("VIDEODUB_LLM_TRANSLATE_RETRIES", "4")))
_llm_translate_sem: asyncio.Semaphore | None = None


def _get_llm_translate_sem() -> asyncio.Semaphore:
    """Lazy-init semaphore bound to current running loop."""
    global _llm_translate_sem
    if _llm_translate_sem is None:
        _llm_translate_sem = asyncio.Semaphore(_LLM_CONCURRENCY)
    return _llm_translate_sem


def _parse_retry_after(err_msg: str) -> float | None:
    """Tìm số giây gợi ý retry trong message lỗi 429. Endpoint trả nhiều dạng:
    `reset in 30s`, `try again in 12 seconds`, `Retry-After: 5`. Trả None nếu
    không phát hiện được."""
    if not err_msg:
        return None
    m = re.search(r"(?:reset|retry|wait|try.*?in)\D*?(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)?",
                  err_msg, re.IGNORECASE)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    m = re.search(r"Retry-After[:\s]+(\d+(?:\.\d+)?)", err_msg, re.IGNORECASE)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    return None

TRANSLATE_CODES = {
    "en": "en", "es": "es", "fr": "fr", "de": "de", "it": "it", "pt": "pt",
    "ru": "ru", "ja": "ja", "ko": "ko", "zh": "zh-CN", "ar": "ar", "hi": "hi",
    "tr": "tr", "pl": "pl", "nl": "nl", "sv": "sv", "th": "th", "vi": "vi",
    "id": "id", "uk": "uk",
}

FLORES_CODES = {
    "en": "eng_Latn", "es": "spa_Latn", "fr": "fra_Latn", "de": "deu_Latn",
    "it": "ita_Latn", "pt": "por_Latn", "ru": "rus_Cyrl", "ja": "jpn_Jpan",
    "ko": "kor_Hang", "zh": "zho_Hans", "zh-CN": "zho_Hans", "ar": "arb_Arab",
    "hi": "hin_Deva", "tr": "tur_Latn", "pl": "pol_Latn", "nl": "nld_Latn",
    "sv": "swe_Latn", "th": "tha_Thai", "vi": "vie_Latn", "id": "ind_Latn",
    "uk": "ukr_Cyrl",
}

# Human-readable language names for LLM prompts. Empirically a tiny / 7B
# local LLM produces Devanagari Hindi reliably when told "translate into
# Hindi" but drifts to German / English / phonetic-Latin when told
# "translate into hi". The two-letter ISO codes "hi" / "de" / "fr" can
# overlap with everyday tokens ("hi" = greeting), which throws off small
# instruction-tuned models. Pass the full name in the prompt so the model
# can't misread it.
LANG_NAMES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German",
    "it": "Italian", "pt": "Portuguese", "ru": "Russian", "ja": "Japanese",
    "ko": "Korean", "zh": "Chinese (Simplified)", "zh-CN": "Chinese (Simplified)",
    "ar": "Arabic", "hi": "Hindi", "tr": "Turkish", "pl": "Polish",
    "nl": "Dutch", "sv": "Swedish", "th": "Thai", "vi": "Vietnamese",
    "id": "Indonesian", "uk": "Ukrainian",
}

# Per-language script enforcement. Maps language code → required Unicode
# block(s) the translation must contain. Used as a sanity gate after the
# LLM responds: if the output contains <50% characters from the expected
# block, we treat the translation as corrupted and retry. The block names
# here are the keys recognised by Python's `unicodedata.name()` lookup or
# regex Unicode property classes.
LANG_REQUIRED_SCRIPT = {
    "hi":  ("DEVANAGARI", (0x0900, 0x097F)),
    "ar":  ("ARABIC",     (0x0600, 0x06FF)),
    "zh":  ("CJK",        (0x4E00, 0x9FFF)),
    "zh-CN": ("CJK",      (0x4E00, 0x9FFF)),
    "ja":  ("JAPANESE",   (0x3040, 0x30FF)),
    "ko":  ("HANGUL",     (0xAC00, 0xD7AF)),
    "th":  ("THAI",       (0x0E00, 0x0E7F)),
    "ru":  ("CYRILLIC",   (0x0400, 0x04FF)),
    "uk":  ("CYRILLIC",   (0x0400, 0x04FF)),
}


def _script_ratio(text: str, code: str) -> float:
    """Fraction of letters in `text` that fall inside the script block we
    expect for `code`. Punctuation/digits/whitespace are excluded from the
    denominator so a Hindi sentence ending in "." still scores 1.0."""
    info = LANG_REQUIRED_SCRIPT.get(code)
    if not info:
        return 1.0
    _, (lo, hi) = info
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 1.0
    inside = sum(1 for c in letters if lo <= ord(c) <= hi)
    return inside / len(letters)


def _looks_like_target(text: str, code: str, threshold: float = 0.5) -> bool:
    """Sanity gate for non-Latin targets. True if `text` is *plausibly* in
    the target language by script. Only meaningful for languages with a
    distinctive script (Indic, CJK, Arabic, etc.); Latin-script targets
    always return True since we can't distinguish English from German by
    codepoints alone."""
    return _script_ratio(text, code) >= threshold

_nllb_model = None
_nllb_tokenizer = None
_nllb_device = None


def _resolve_source_lang(req: TranslateRequest) -> str:
    """Pick source language: explicit request > job.source_lang > 'en' fallback."""
    if getattr(req, "source_lang", None):
        return req.source_lang
    if getattr(req, "job_id", None):
        job = _get_job(req.job_id)
        if job and job.get("source_lang"):
            return job["source_lang"]
    return "en"


def _unload_nllb():
    """Release NLLB VRAM so TTS model can reload."""
    global _nllb_model, _nllb_tokenizer
    import gc
    _nllb_model = None
    _nllb_tokenizer = None
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:
        pass


@router.get("/api/genres")
async def list_translation_genres():
    """Danh sách preset thể loại cho dropdown Genre trong UI.

    Nguồn: skill MD files ở `backend/skills/translate/` (overlay) +
    hardcoded GENRES (fallback layer khi folder trống).
    """
    from services.translation_genres import list_genres
    return {"genres": list_genres()}


@router.post("/api/skills/translate/reload")
async def reload_translate_skills():
    """Force-reload translate skills từ folder `backend/skills/translate/`.

    Dùng sau khi user edit / thêm / xóa file MD mà không muốn restart backend.
    """
    from services.translation_skills import reload_skills, list_skills
    reload_skills()
    return {"skills": list_skills(), "count": len(list_skills())}


@router.post("/dub/segment/shorten")
async def shorten_segment(payload: dict):
    """LLM-rút-gọn 1 segment cho vừa slot, giữ tone genre.

    Input:
      {
        "text": "câu cần rút gọn",
        "slot_seconds": 4.0,         # độ dài slot từ source
        "target_lang": "vi",
        "source_text": "câu gốc (optional, cho LLM hiểu nghĩa)",
        "genre_id": "cdrama_business" # optional, để LLM giữ văn phong
      }

    Output:
      {
        "text": "câu đã rút",
        "rate_ratio": 1.08,          # ratio mới sau rút
        "old_rate_ratio": 1.85,      # ratio trước
        "severity": "ok",            # ok / warn / critical / short
        "attempts": 2,
        "error": null
      }

    Trả mã 200 cả khi rút không thành (text gốc giữ nguyên, error field cho
    biết lý do — vd "no-llm"). Frontend nên check `text === payload.text` để
    biết có thay đổi.
    """
    from services.speech_rate import (
        adjust_for_slot, rate_ratio as compute_ratio, severity_tier,
    )

    text = (payload.get("text") or "").strip()
    slot = float(payload.get("slot_seconds") or 0.0)
    target_lang = payload.get("target_lang") or "vi"
    source_text = payload.get("source_text") or None
    genre_id = payload.get("genre_id") or None

    if not text:
        return {"error": "empty text", "text": "", "rate_ratio": 1.0, "severity": "ok"}
    if slot <= 0:
        return {"error": "invalid slot_seconds", "text": text, "rate_ratio": 1.0, "severity": "ok"}

    old_ratio = compute_ratio(text, slot, target_lang)
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: adjust_for_slot(
            text,
            slot_seconds=slot,
            target_lang=target_lang,
            source_text=source_text,
            genre_id=genre_id,
        ),
    )
    new_ratio = result.get("rate_ratio", old_ratio)
    return {
        "text": result.get("text", text),
        "rate_ratio": round(new_ratio, 3),
        "old_rate_ratio": round(old_ratio, 3),
        "severity": severity_tier(new_ratio),
        "old_severity": severity_tier(old_ratio),
        "attempts": result.get("attempts", 0),
        "error": result.get("error"),
    }


@router.post("/dub/segment/rate-check")
async def rate_check_segment(payload: dict):
    """Tính nhanh ratio + severity cho 1 segment — không gọi LLM.

    Dùng cho frontend hiển thị warning badge sau khi user edit text inline.
    """
    from services.speech_rate import rate_ratio as compute_ratio, severity_tier

    text = (payload.get("text") or "").strip()
    slot = float(payload.get("slot_seconds") or 0.0)
    target_lang = payload.get("target_lang") or "vi"
    if not text or slot <= 0:
        return {"rate_ratio": 1.0, "severity": "ok"}
    r = compute_ratio(text, slot, target_lang)
    return {"rate_ratio": round(r, 3), "severity": severity_tier(r)}


@router.post("/dub/translate")
async def dub_translate(req: TranslateRequest):
    try:
        provider = (req.provider if req.provider else os.environ.get("TRANSLATE_PROVIDER", "google")).lower()
        lang_code = TRANSLATE_CODES.get(req.target_lang, req.target_lang)
        api_key = os.environ.get("TRANSLATE_API_KEY", "")
        loop = asyncio.get_running_loop()
        src_lang = _resolve_source_lang(req)

        # Offline NLLB Transformer Translation
        if provider == "nllb":
            flores_tgt = FLORES_CODES.get(req.target_lang, "eng_Latn")
            flores_src = FLORES_CODES.get(src_lang, "eng_Latn")

            def _translate_nllb():
                global _nllb_model, _nllb_tokenizer, _nllb_device
                import torch
                from transformers import AutoTokenizer, AutoModelForSeq2SeqLM

                if torch.cuda.is_available():
                    target_device = "cuda"
                elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                    target_device = "mps"
                else:
                    target_device = "cpu"

                try:
                    if _nllb_tokenizer is None:
                        _nllb_tokenizer = AutoTokenizer.from_pretrained("facebook/nllb-200-distilled-600M")
                    if _nllb_model is None:
                        _nllb_model = AutoModelForSeq2SeqLM.from_pretrained("facebook/nllb-200-distilled-600M")
                        if target_device != "cpu":
                            try:
                                _nllb_model = _nllb_model.to(target_device)
                                _nllb_device = target_device
                            except Exception as e:
                                logger.warning("NLLB %s placement failed, falling back to CPU: %s", target_device, e)
                                _nllb_device = "cpu"
                        else:
                            _nllb_device = "cpu"
                except Exception as e:
                    logger.exception("NLLB model load failed")
                    return [{"id": seg.id, "text": seg.text, "error": f"Model load error: {str(e)}"} for seg in req.segments]

                results = []
                for seg in req.segments:
                    try:
                        if not seg.text or not seg.text.strip():
                            results.append({"id": seg.id, "text": seg.text})
                            continue

                        tgt = FLORES_CODES.get(seg.target_lang, flores_tgt) if seg.target_lang else flores_tgt

                        _nllb_tokenizer.src_lang = flores_src
                        inputs = _nllb_tokenizer(seg.text, return_tensors="pt")
                        if _nllb_device and _nllb_device != "cpu":
                            inputs = {k: v.to(_nllb_device) for k, v in inputs.items()}

                        forced_bos_token_id = _nllb_tokenizer.convert_tokens_to_ids(tgt)
                        try:
                            translated_tokens = _nllb_model.generate(
                                **inputs, forced_bos_token_id=forced_bos_token_id, max_length=400
                            )
                        except (RuntimeError, NotImplementedError) as e:
                            if _nllb_device == "mps":
                                logger.warning("MPS generate failed, retrying on CPU: %s", e)
                                _nllb_model.to("cpu")
                                _nllb_device = "cpu"
                                inputs = {k: v.to("cpu") for k, v in inputs.items()}
                                translated_tokens = _nllb_model.generate(
                                    **inputs, forced_bos_token_id=forced_bos_token_id, max_length=400
                                )
                            else:
                                raise
                        translated_text = _nllb_tokenizer.batch_decode(translated_tokens, skip_special_tokens=True)[0]
                        results.append({"id": seg.id, "text": translated_text})
                    except Exception as e:
                        results.append({"id": seg.id, "text": seg.text, "error": str(e)})
                return results

            translated = await loop.run_in_executor(_gpu_pool, _translate_nllb)
            if os.environ.get("OMNIVOICE_UNLOAD_NLLB", "1") == "1":
                _unload_nllb()
            return await _post_process_translate(translated, req, src_lang, loop)

        # OpenAI / Ollama Local LLM Translation
        if provider == "openai":
            # Ưu tiên prefs DB (UI Settings → LLM Provider), fallback env.
            # Trước đây chỉ đọc env nên user set xong qua UI vẫn dùng "local"
            # làm api_key → server LLM tự host trả 401.
            from api.routers.prefs import get_llm_config
            llm_cfg = get_llm_config()
            base_url = (
                os.environ.get("TRANSLATE_BASE_URL")
                or llm_cfg.get("base_url")
            )
            model_name = (
                os.environ.get("TRANSLATE_MODEL")
                or llm_cfg.get("model")
                or "gpt-3.5-turbo"
            )
            effective_key = api_key or llm_cfg.get("api_key") or ""
            from openai import OpenAI
            client = OpenAI(base_url=base_url, api_key=effective_key or "local")

            # Lấy genre prompt extra (string rỗng nếu không pick)
            from services.translation_genres import get_genre_prompt
            genre_extra = get_genre_prompt(getattr(req, "genre", None))

            def _build_prompt(src_code: str, tgt_code: str) -> str:
                """Build a system prompt that resists hallucinations on small
                local LLMs. Three things matter:

                1. Use full language names (Hindi, German) not ISO codes —
                   tiny models read 'hi' as a greeting and drift.
                2. For non-Latin targets, name the required script explicitly
                   so the model can't fall back to phonetic Latin or another
                   target it knows better (Hindi → German is a common drift
                   we've actually observed).
                3. End with a strict format guard so the model can't prepend
                   'Translation:' or quote the output.
                """
                src_name = LANG_NAMES.get(src_code, src_code)
                tgt_name = LANG_NAMES.get(tgt_code, tgt_code)
                script_clause = ""
                info = LANG_REQUIRED_SCRIPT.get(tgt_code)
                if info:
                    script_name, _ = info
                    script_clause = (
                        f" The output MUST be written in {script_name} script "
                        f"only — do not use Latin/Roman letters, do not "
                        f"transliterate, do not output any other language."
                    )
                base = (
                    f"You are a professional dubbing translator. "
                    f"Translate the user's text from {src_name} into "
                    f"{tgt_name}.{script_clause} "
                    f"Reply ONLY with the translated {tgt_name} text, do not "
                    f"add quotes, notes, headers, explanations, or commentary."
                )
                if genre_extra:
                    base = base + " " + genre_extra
                return base

            def _call_once(seg, sys_for_attempt):
                """Một lần gọi LLM thuần (blocking). Caller xử lý retry / sem."""
                res = client.chat.completions.create(
                    model=model_name,
                    temperature=0.2,
                    messages=[
                        {"role": "system", "content": sys_for_attempt},
                        {"role": "user", "content": seg.text},
                    ],
                )
                return (res.choices[0].message.content or "").strip()

            async def _translate_llm(seg):
                if not seg.text or not seg.text.strip():
                    return {"id": seg.id, "text": seg.text}
                tgt_code = seg.target_lang if seg.target_lang else req.target_lang
                system_msg = _build_prompt(src_lang, tgt_code)
                last_err = None
                # Up to 2 attempts cho script-mismatch + N retries cho 429.
                for attempt in range(2):
                    sys_for_attempt = system_msg
                    if attempt == 1:
                        sys_for_attempt = (
                            system_msg
                            + " Your previous attempt produced output in the "
                            "wrong language or script. Output ONLY the "
                            f"{LANG_NAMES.get(tgt_code, tgt_code)} translation."
                        )

                    # Retry loop cho 429 / transient errors.
                    backoff = 1.0
                    for retry in range(_LLM_MAX_RETRIES + 1):
                        try:
                            async with _get_llm_translate_sem():
                                out_text = await loop.run_in_executor(
                                    _cpu_pool, _call_once, seg, sys_for_attempt,
                                )
                            break  # success — thoát retry loop
                        except Exception as e:
                            last_err = f"{type(e).__name__}: {e}"
                            err_str = str(e)
                            is_rate_limit = (
                                "429" in err_str
                                or "RateLimitError" in type(e).__name__
                                or "rate limit" in err_str.lower()
                                or "usage limit" in err_str.lower()
                            )
                            if is_rate_limit and retry < _LLM_MAX_RETRIES:
                                hint = _parse_retry_after(err_str)
                                wait_s = hint if hint else backoff
                                # Jitter ±20% để các segment không cùng wake một lúc
                                wait_s *= 1.0 + random.uniform(-0.2, 0.2)
                                logger.warning(
                                    "translate %s: 429 (attempt %d/retry %d), sleeping %.1fs",
                                    seg.id, attempt + 1, retry + 1, wait_s,
                                )
                                await asyncio.sleep(wait_s)
                                backoff = min(backoff * 2, 30.0)
                                continue
                            logger.warning(
                                "translate %s: LLM attempt %d failed: %s",
                                seg.id, attempt + 1, e,
                            )
                            out_text = None
                            break
                    else:
                        out_text = None

                    if not out_text:
                        last_err = last_err or "empty LLM response"
                        continue
                    if not _looks_like_target(out_text, tgt_code):
                        last_err = (
                            f"LLM output script_ratio={_script_ratio(out_text, tgt_code):.2f} "
                            f"below threshold for {tgt_code}"
                        )
                        logger.warning(
                            "translate %s: attempt %d wrong script (%s); retrying",
                            seg.id, attempt + 1, last_err,
                        )
                        continue
                    return {"id": seg.id, "text": out_text}
                return {"id": seg.id, "text": seg.text, "error": last_err or "llm-failed"}

            translated = await asyncio.gather(*(_translate_llm(seg) for seg in req.segments))
            translated.sort(key=lambda x: str(x["id"]))
            return await _post_process_translate(list(translated), req, src_lang, loop)

        # Offline Argos Translate
        if provider == "argos" or provider == "libretranslate":
            def _translate_argos():
                cache_dir = os.environ.get("OMNIVOICE_CACHE_DIR")
                if cache_dir:
                    argos_cache = os.path.join(cache_dir, "argos-translate")
                    os.makedirs(argos_cache, exist_ok=True)
                    os.environ.setdefault("ARGOS_PACKAGES_DIR", argos_cache)
                    os.environ.setdefault("ARGOS_DATA_DIR", argos_cache)
                import argostranslate.package
                import argostranslate.translate

                from_code = src_lang
                available_packages = argostranslate.package.get_installed_packages()

                results = []
                for seg in req.segments:
                    try:
                        if not seg.text or not seg.text.strip():
                            results.append({"id": seg.id, "text": seg.text})
                            continue
                        to_code = seg.target_lang if seg.target_lang else req.target_lang
                        installed_pkg = next(filter(lambda x: x.from_code == from_code and x.to_code == to_code, available_packages), None)

                        if installed_pkg is None:
                            argostranslate.package.update_package_index()
                            all_packages = argostranslate.package.get_available_packages()
                            package_to_install = next(filter(lambda x: x.from_code == from_code and x.to_code == to_code, all_packages), None)
                            if package_to_install:
                                argostranslate.package.install_from_path(package_to_install.download())
                                available_packages = argostranslate.package.get_installed_packages()
                            else:
                                raise Exception(f"No Argos package available for {from_code} -> {to_code}")

                        translated_text = argostranslate.translate.translate(seg.text, from_code, to_code)
                        results.append({"id": seg.id, "text": translated_text})
                    except Exception as e:
                        results.append({"id": seg.id, "text": seg.text, "error": str(e)})
                return results

            translated = await loop.run_in_executor(_cpu_pool, _translate_argos)
            return await _post_process_translate(translated, req, src_lang, loop)

        # Legacy / API Deep_Translator logic.
        # Preflight the optional `deep_translator` dep once so we fail with a
        # single actionable error instead of N identical per-segment
        # ModuleNotFoundErrors that flood the UI's error badge.
        try:
            import deep_translator  # noqa: F401
        except ImportError:
            friendly = (
                f"The '{provider}' translation engine needs the optional "
                f"`deep_translator` Python package, which isn't installed in "
                f"this backend. Install it with `uv pip install deep_translator` "
                f"(or `pip install deep_translator`) and restart the server, or "
                f"switch the Engine dropdown to Argos (local, bundled), NLLB "
                f"(local, heavier), or OpenAI (LLM)."
            )
            return JSONResponse(status_code=400, content={"error": friendly})

        src_arg = TRANSLATE_CODES.get(src_lang, src_lang) or "auto"

        def _build_translator(src, tgt):
            if provider == "deepl":
                from deep_translator import DeeplTranslator
                return DeeplTranslator(api_key=api_key, source=src, target=tgt)
            if provider == "mymemory":
                from deep_translator import MyMemoryTranslator
                return MyMemoryTranslator(source=src, target=tgt)
            if provider == "microsoft":
                from deep_translator import MicrosoftTranslator
                return MicrosoftTranslator(api_key=api_key, source=src, target=tgt)
            from deep_translator import GoogleTranslator
            return GoogleTranslator(source=src, target=tgt)

        def _translate_single(seg):
            seg_lc = (
                TRANSLATE_CODES.get(seg.target_lang, seg.target_lang)
                if seg.target_lang else lang_code
            )
            if not seg.text or not seg.text.strip():
                return {"id": seg.id, "text": seg.text}
            last_err = None
            # Try: (src_arg, tgt) → retry once → fall back to (auto, tgt).
            for attempt, src in enumerate([src_arg, src_arg, "auto"]):
                try:
                    out = _build_translator(src, seg_lc).translate(seg.text)
                    if out and out.strip():
                        return {"id": seg.id, "text": out}
                    last_err = "empty translation"
                except Exception as e:
                    last_err = f"{type(e).__name__}: {e}"
                    logger.warning(
                        "translate attempt %d %s->%s (provider=%s) failed: %s",
                        attempt + 1, src, seg_lc, provider, e,
                    )
                    time.sleep(0.25 * (attempt + 1))
            logger.error("translate %s -> %s gave up (provider=%s): %s", src_arg, seg_lc, provider, last_err)
            return {"id": seg.id, "text": seg.text, "error": last_err or "unknown"}

        tasks = [loop.run_in_executor(_cpu_pool, _translate_single, seg) for seg in req.segments]
        translated = await asyncio.gather(*tasks)
        translated.sort(key=lambda x: str(x["id"]))

        return await _post_process_translate(
            translated, req, src_lang, loop,
        )
    except Exception as e:
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


async def _apply_slot_fit(translated: list[dict], req, src_lang: str) -> list[dict]:
    """Run the LLM speech-rate fit pass over any segment whose request carried
    `slot_seconds`. Trims overflowing translations and expands underrunning ones
    so TTS won't need to time-stretch (pitch artifact) or hard-trim (mid-word
    clip) the audio later.

    Runs for any translator provider — fast Google, NLLB, LLM one-shot, and
    cinematic alike. Silently no-ops when the LLM is off (services/speech_rate
    handles that internally), so the call site doesn't need to gate on it.
    """
    slots_by_id: dict[str, float] = {
        str(s.id): float(s.slot_seconds)
        for s in req.segments
        if getattr(s, "slot_seconds", None) and float(s.slot_seconds) > 0
    }
    if not slots_by_id:
        return translated
    source_by_id: dict[str, str] = {str(s.id): s.text for s in req.segments}

    from services.speech_rate import adjust_for_slot, rate_ratio, TOL_LOW, TOL_HIGH

    # Re-use the translate semaphore so the slot-fit pass shares the same
    # LLM back-pressure ceiling as the translation step itself. Without this,
    # gathering N segments × up-to-3 retries each could blow past a local
    # Ollama / LM Studio's queue or trip a cloud endpoint's 429.
    sem = _get_llm_translate_sem()

    async def _fit_one(row: dict) -> dict:
        seg_id = str(row.get("id"))
        text = (row.get("text") or "").strip()
        slot = slots_by_id.get(seg_id)
        if not text or not slot or row.get("error"):
            return row
        # Cheap check first — if already inside tolerance, skip the LLM call.
        r = rate_ratio(text, slot, req.target_lang)
        if TOL_LOW <= r <= TOL_HIGH:
            row["rate_ratio"] = r
            return row
        try:
            async with sem:
                fit = await asyncio.to_thread(
                    adjust_for_slot,
                    text,
                    slot_seconds=slot,
                    target_lang=req.target_lang,
                    source_text=source_by_id.get(seg_id),
                )
            if fit.get("text"):
                row["text"] = fit["text"]
            row["rate_ratio"] = fit.get("rate_ratio")
            if fit.get("error"):
                row["rate_error"] = fit["error"]
        except Exception as e:
            logger.warning("rate-fit skipped for %s: %s", seg_id, e)
        return row

    return await asyncio.gather(*(_fit_one(row) for row in translated))


async def _post_process_translate(translated, req, src_lang, loop):
    """Run optional cinematic refinement, then the slot-fit pass over the
    final text. Both passes are no-ops when their preconditions are missing
    (LLM unavailable / no slot_seconds), so this is safe to call from every
    provider path.
    """
    quality = (getattr(req, "quality", None) or "fast").lower()
    cinematic_skipped: Optional[str] = None

    if quality == "cinematic":
        if not cinematic_available():
            logger.warning("cinematic requested but no LLM configured — returning Fast result.")
            cinematic_skipped = "no-llm-configured"
        else:
            source_by_id: dict[str, str] = {str(s.id): s.text for s in req.segments}
            directions: dict[str, str] = {
                str(s.id): s.direction
                for s in req.segments
                if getattr(s, "direction", None)
            }
            pairs = []
            passthrough_index: dict[str, dict] = {}
            for row in translated:
                seg_id = str(row["id"])
                literal = row.get("text", "") or ""
                if row.get("error") or not literal.strip():
                    passthrough_index[seg_id] = row
                    continue
                pairs.append((seg_id, source_by_id.get(seg_id, ""), literal))

            if pairs:
                refined = await cinematic_refine_many(
                    pairs,
                    source_lang=src_lang,
                    target_lang=req.target_lang,
                    glossary=req.glossary,
                    directions=directions,
                    executor=_cpu_pool,
                )
                refined_by_id = {r["id"]: r for r in refined}

                merged = []
                for row in translated:
                    seg_id = str(row["id"])
                    if seg_id in passthrough_index:
                        merged.append(row)
                        continue
                    r = refined_by_id.get(seg_id)
                    if r is None:
                        merged.append(row)
                        continue
                    out = {
                        "id": row["id"],
                        "text": r["text"],
                        "literal": r["literal"],
                        "critique": r.get("critique", ""),
                    }
                    if r.get("error"):
                        out["error"] = r["error"]
                    merged.append(out)
                translated = merged

    translated = await _apply_slot_fit(translated, req, src_lang)

    resp = {
        "translated": translated,
        "target_lang": req.target_lang,
        "source_lang": src_lang,
        "quality_used": "cinematic" if (quality == "cinematic" and not cinematic_skipped) else "fast",
    }
    if cinematic_skipped:
        resp["cinematic_skipped"] = cinematic_skipped
    return resp


# Backward-compat alias — older callers / tests may still import this name.
_maybe_cinematic = _post_process_translate
