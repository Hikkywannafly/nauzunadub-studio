"""Application preferences router — UI-managed config persisted to prefs.json.

Currently exposed keys:
  - llm_base_url   (default: env VIDEODUB_LLM_BASE_URL → https://api.openai.com/v1)
  - llm_model      (default: env VIDEODUB_LLM_MODEL    → gpt-4o-mini)
  - llm_api_key    (default: env VIDEODUB_LLM_API_KEY or OPENAI_API_KEY)
  - target_lang    (default: "vi")
  - tts_backend    (default: "omnivoice")
  - asr_backend    (default: "whisperx")

The GET endpoint never returns the api_key in clear text — only a boolean
``llm_api_key_set`` so the UI can show a "configured ✓" badge without leaking
the secret back to the browser on every page load.
"""
from __future__ import annotations

from typing import Optional, Any
from fastapi import APIRouter
from pydantic import BaseModel

from core import prefs
from core.config import (
    DEFAULT_LLM_BASE_URL,
    DEFAULT_LLM_MODEL,
    DEFAULT_LLM_API_KEY,
)

router = APIRouter(prefix="/api/prefs", tags=["prefs"])


class PrefsResponse(BaseModel):
    llm_base_url: str
    llm_model: str
    llm_api_key_set: bool
    target_lang: str
    tts_backend: str
    asr_backend: str


class PrefsUpdate(BaseModel):
    llm_base_url: Optional[str] = None
    llm_model: Optional[str] = None
    llm_api_key: Optional[str] = None  # "" → clear; None → leave unchanged
    target_lang: Optional[str] = None
    tts_backend: Optional[str] = None
    asr_backend: Optional[str] = None


def _resolve(key: str, default: Any) -> Any:
    v = prefs.get(key, None)
    return v if v not in (None, "") else default


def get_llm_config() -> dict:
    """Used by translator/llm_backend to fetch the current LLM provider config."""
    return {
        "base_url": _resolve("llm_base_url", DEFAULT_LLM_BASE_URL),
        "model": _resolve("llm_model", DEFAULT_LLM_MODEL),
        "api_key": _resolve("llm_api_key", DEFAULT_LLM_API_KEY),
    }


@router.get("", response_model=PrefsResponse)
def get_prefs() -> PrefsResponse:
    api_key = _resolve("llm_api_key", DEFAULT_LLM_API_KEY)
    return PrefsResponse(
        llm_base_url=_resolve("llm_base_url", DEFAULT_LLM_BASE_URL),
        llm_model=_resolve("llm_model", DEFAULT_LLM_MODEL),
        llm_api_key_set=bool(api_key),
        target_lang=_resolve("target_lang", "vi"),
        tts_backend=_resolve("tts_backend", "omnivoice"),
        asr_backend=_resolve("asr_backend", "whisperx"),
    )


@router.put("", response_model=PrefsResponse)
def update_prefs(body: PrefsUpdate) -> PrefsResponse:
    if body.llm_base_url is not None:
        prefs.set_("llm_base_url", body.llm_base_url.strip())
    if body.llm_model is not None:
        prefs.set_("llm_model", body.llm_model.strip())
    if body.llm_api_key is not None:
        # Empty string explicitly clears the stored key.
        prefs.set_("llm_api_key", body.llm_api_key.strip())
    if body.target_lang is not None:
        prefs.set_("target_lang", body.target_lang.strip())
    if body.tts_backend is not None:
        prefs.set_("tts_backend", body.tts_backend.strip())
    if body.asr_backend is not None:
        prefs.set_("asr_backend", body.asr_backend.strip())
    # Invalidate cached LLM client so the new config takes effect on the
    # very next /translate request — no backend restart required.
    try:
        from services import llm_backend
        for cls in llm_backend._REGISTRY.values():
            inst = getattr(cls, "_singleton", None)
            if inst is not None and hasattr(inst, "invalidate_client"):
                inst.invalidate_client()
    except Exception:
        pass
    return get_prefs()


@router.post("/test-llm")
def test_llm() -> dict:
    """Smoke-test the configured LLM endpoint with a trivial completion.

    Returns ``{ok: bool, detail: str, latency_ms: int}``. Used by the
    Settings → LLM Provider page so a user can verify their Ollama / LM Studio
    / OpenAI config without first running a full translate job.
    """
    import time
    cfg = get_llm_config()
    if not cfg["api_key"] and "openai.com" in cfg["base_url"]:
        return {"ok": False, "detail": "API key required for OpenAI", "latency_ms": 0}
    try:
        from openai import OpenAI
        # Ollama/LM Studio don't validate the key, but the SDK requires a non-empty string.
        client = OpenAI(base_url=cfg["base_url"], api_key=cfg["api_key"] or "sk-local")
        t0 = time.time()
        resp = client.chat.completions.create(
            model=cfg["model"],
            messages=[{"role": "user", "content": "ping"}],
            max_tokens=4,
        )
        latency = int((time.time() - t0) * 1000)
        out = (resp.choices[0].message.content or "").strip()
        return {"ok": True, "detail": f"reply: {out[:40]}", "latency_ms": latency}
    except Exception as e:
        return {"ok": False, "detail": str(e)[:200], "latency_ms": 0}
