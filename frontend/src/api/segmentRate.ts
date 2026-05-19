import { apiJson } from './client';

export interface ShortenRequest {
  text: string;
  slot_seconds: number;
  target_lang: string;
  source_text?: string;
  genre_id?: string;
}

export interface ShortenResponse {
  text: string;
  rate_ratio: number;
  old_rate_ratio: number;
  severity: SeverityTier;
  old_severity: SeverityTier;
  attempts: number;
  error?: string | null;
}

export interface RateCheckResponse {
  rate_ratio: number;
  severity: SeverityTier;
}

export type SeverityTier = 'ok' | 'warn' | 'critical' | 'short';

/** LLM rút gọn segment cho vừa slot, giữ tone genre. */
export async function shortenSegment(req: ShortenRequest): Promise<ShortenResponse> {
  return apiJson<ShortenResponse>('/dub/segment/shorten', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

/** Bidirectional: shorten when vượt slot, expand when short. Cùng response
 * shape với shortenSegment — frontend chỉ đổi label theo direction. */
export async function optimizeSegment(req: ShortenRequest): Promise<ShortenResponse> {
  return apiJson<ShortenResponse>('/dub/segment/optimize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

/** Tính ratio + severity (không gọi LLM) — cho preview/badge. */
export async function rateCheckSegment(
  text: string,
  slotSeconds: number,
  targetLang: string,
): Promise<RateCheckResponse> {
  return apiJson<RateCheckResponse>('/dub/segment/rate-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, slot_seconds: slotSeconds, target_lang: targetLang }),
  });
}

// ── Local fast path — mirror backend's _RATE_CPS for instant UI feedback ──
// Frontend tính local để không phải gọi API mỗi keystroke. Backend là source
// of truth (vd khi user click "Shorten" → backend recompute).
const RATE_CPS: Record<string, number> = {
  en: 15.0, de: 14.0, fr: 15.0, es: 15.5, it: 15.0, pt: 15.0,
  ja: 10.0, ko: 10.0, zh: 6.0, vi: 13.0,
};

export function expectedDuration(text: string, lang = 'en'): number {
  const cps = RATE_CPS[lang.split('-')[0].toLowerCase()] ?? 13.0;
  return text.length / Math.max(1.0, cps);
}

export function rateRatio(text: string, slotSeconds: number, lang = 'en'): number {
  if (slotSeconds <= 0) return 1.0;
  return expectedDuration(text, lang) / slotSeconds;
}

export function severityTier(ratio: number): SeverityTier {
  if (ratio > 1.50) return 'critical';
  if (ratio > 1.15) return 'warn';
  if (ratio < 0.85) return 'short';
  return 'ok';
}
