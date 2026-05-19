import { API, apiUrl, apiJson, apiPost, apiFetch } from './client';
import type { DubHistoryResponse, DubTranslateResponse } from './types';

export async function dubUpload(
  file: File | Blob,
  jobId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<unknown> {
  const fd = new FormData();
  fd.append('video', file);
  fd.append('job_id', jobId);
  return apiPost('/dub/upload', fd, { signal });
}

export interface IngestUrlOptions {
  signal?: AbortSignal;
  /** Ask yt-dlp to also pull caption tracks (incl. YouTube auto-translations). */
  fetchSubs?: boolean;
  /** Limit caption fetch to specific lang codes; defaults to all available. */
  subLangs?: string[];
}

export async function dubIngestUrl(
  url: string,
  jobId: string,
  opts: IngestUrlOptions = {},
): Promise<unknown> {
  const { signal, fetchSubs, subLangs } = opts;
  return apiPost(
    '/dub/ingest-url',
    {
      url,
      job_id: jobId,
      fetch_subs: fetchSubs || undefined,
      sub_langs: subLangs && subLangs.length ? subLangs : undefined,
    },
    { signal },
  );
}

export function transcribeStreamUrl(jobId: string): string {
  return `${API}/dub/transcribe-stream/${jobId}`;
}

export async function dubAbort(jobId: string): Promise<void> {
  try { await apiFetch(`/dub/abort/${jobId}`, { method: 'POST' }); } catch { /* best-effort */ }
}

export async function dubCleanupSegments(jobId: string): Promise<unknown> {
  return apiPost(`/dub/cleanup-segments/${jobId}`);
}

export interface DubImportSrtResponse {
  segments: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
    text_original: string;
    speaker_id: string;
  }>;
  stats: {
    imported: number;
    skipped_malformed: number;
    dropped_overlap: number;
    clamped_to_duration: number;
  };
}

export async function dubImportSrt(jobId: string, file: File | Blob): Promise<DubImportSrtResponse> {
  const fd = new FormData();
  fd.append('file', file);
  return apiPost<DubImportSrtResponse>(`/dub/import-srt/${jobId}`, fd);
}

export async function dubTranslate(body: Record<string, unknown>): Promise<DubTranslateResponse> {
  return apiPost<DubTranslateResponse>('/dub/translate', body);
}

export async function dubGenerate(jobId: string, body: Record<string, unknown>): Promise<unknown> {
  return apiPost(`/dub/generate/${jobId}`, body);
}

export function tasksStreamUrl(taskId: string): string {
  return apiUrl(`/tasks/stream/${taskId}`);
}

export async function tasksCancel(taskId: string): Promise<Response> {
  return apiFetch(`/tasks/cancel/${taskId}`, { method: 'POST' });
}

export async function listDubHistory(): Promise<DubHistoryResponse> {
  return apiJson<DubHistoryResponse>('/dub/history');
}

export async function clearDubHistory(): Promise<Response> {
  return apiFetch('/dub/history', { method: 'DELETE' });
}

/** Sync frontend segments → backend job["segments"]. Debounced caller pattern.
 * Idempotent — backend overwrites blindly. Use after every text/time edit. */
export async function syncDubSegments(jobId: string, segments: unknown[]): Promise<{ ok: boolean; count: number }> {
  return apiPost(`/dub/segments/${jobId}`, { segments });
}

// ── Translation snapshots ────────────────────────────────────────────────
export interface TranslationSnapshot {
  id: string;
  created_at: number;
  target_lang: string;
  source_lang?: string;
  provider?: string | null;
  quality?: string;
  genre?: string | null;
  segments_count: number;
  applied_count?: number;
  total_count?: number;
}

export async function listTranslationSnapshots(jobId: string): Promise<{ snapshots: TranslationSnapshot[] }> {
  return apiJson(`/dub/translations/${jobId}`);
}

export async function restoreTranslationSnapshot(jobId: string, snapId: string): Promise<{ applied: number; skipped_errors?: number; segments: unknown[]; snapshot_id: string }> {
  return apiPost(`/dub/translations/${jobId}/restore/${snapId}`, {});
}

export interface TranslationSnapshotFull extends TranslationSnapshot {
  rows: Array<{ id: string; text: string; literal?: string; error?: string }>;
}

export async function getTranslationSnapshot(jobId: string, snapId: string): Promise<TranslationSnapshotFull> {
  return apiJson(`/dub/translations/${jobId}/${snapId}`);
}

export async function deleteTranslationSnapshot(jobId: string, snapId: string): Promise<Response> {
  return apiFetch(`/dub/translations/${jobId}/${snapId}`, { method: 'DELETE' });
}

// ── Timeline rebalance ────────────────────────────────────────────────────
export interface TimelineSnapshot {
  id: string;
  created_at: number;
  mode: string;
}

export interface RebalanceStats {
  mode: string;
  runs: number;
  shifted: number;
  max_drift_s: number;
  total_segs: number;
  fallback_reason?: string;
}

export interface CPSSummary {
  mean_cps: number;
  max_cps: number;
  target_cps: number;
  over_count: number;
}

export interface RebalanceResponse {
  segments: unknown[];
  snapshot_id: string;
  stats: RebalanceStats;
  before: CPSSummary;
  after: CPSSummary;
}

export async function rebalanceTimeline(
  jobId: string,
  mode: 'even' | 'ai',
  opts: { max_drift_s?: number } = {},
): Promise<RebalanceResponse> {
  return apiPost(`/dub/timeline/rebalance/${jobId}`, { mode, ...opts });
}

export async function listTimelineSnapshots(jobId: string): Promise<{ snapshots: TimelineSnapshot[] }> {
  return apiJson(`/dub/timeline/snapshots/${jobId}`);
}

export async function restoreTimelineSnapshot(jobId: string, snapId: string): Promise<{ restored: number; segments: unknown[] }> {
  return apiPost(`/dub/timeline/restore/${jobId}/${snapId}`, {});
}

export async function deleteTimelineSnapshot(jobId: string, snapId: string): Promise<Response> {
  return apiFetch(`/dub/timeline/snapshots/${jobId}/${snapId}`, { method: 'DELETE' });
}

// ── Custom background audio ──────────────────────────────────────────────
export interface CustomBgInfo {
  exists: boolean;
  filename?: string;
  size_bytes?: number;
}

export async function uploadCustomBg(jobId: string, file: File | Blob): Promise<{ ok: boolean; filename: string; size_bytes: number }> {
  const fd = new FormData();
  fd.append('file', file);
  return apiPost(`/dub/bg/${jobId}`, fd);
}

export async function getCustomBgInfo(jobId: string): Promise<CustomBgInfo> {
  return apiJson(`/dub/bg/${jobId}`);
}

export async function deleteCustomBg(jobId: string): Promise<Response> {
  return apiFetch(`/dub/bg/${jobId}`, { method: 'DELETE' });
}
