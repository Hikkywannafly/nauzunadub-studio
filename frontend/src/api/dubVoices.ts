import { apiJson, apiPost, apiDelete } from './client';

export interface SpeakerInfo {
  speaker_id: string;
  segment_count: number;
  total_duration: number;
  sample_text: string;
  first_start: number;
  profile_id: string | null;
  engine: string | null;
  pitch: number;
  speed: number;
  volume: number;
}

export interface SpeakerAssignment {
  profile_id?: string | null;
  engine?: string | null;
  pitch?: number;
  speed?: number;
  volume?: number;
}

export interface PreviewResponse {
  preview_url: string;
  filename: string;
  sample_rate: number;
  duration: number;
}

export interface RegenerateResponse {
  segment_id: string;
  filename: string;
  duration: number;
}

export async function listSpeakers(jobId: string): Promise<SpeakerInfo[]> {
  return apiJson<SpeakerInfo[]>(`/api/dub/${jobId}/speakers`);
}

export async function setSpeakerAssignment(
  jobId: string,
  speakerId: string,
  body: SpeakerAssignment,
): Promise<SpeakerInfo> {
  return apiJson<SpeakerInfo>(`/api/dub/${jobId}/speakers/${encodeURIComponent(speakerId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function clearSpeakerAssignment(jobId: string, speakerId: string): Promise<void> {
  await apiDelete(`/api/dub/${jobId}/speakers/${encodeURIComponent(speakerId)}`);
}

export async function previewVoice(
  jobId: string,
  speakerId: string,
  text?: string,
): Promise<PreviewResponse> {
  return apiPost<PreviewResponse>(`/api/dub/${jobId}/preview-voice`, {
    speaker_id: speakerId,
    text,
  });
}

export async function regenerateSegment(
  jobId: string,
  segId: string,
  text?: string,
): Promise<RegenerateResponse> {
  return apiPost<RegenerateResponse>(`/api/dub/${jobId}/segments/${encodeURIComponent(segId)}/regenerate`, {
    text,
  });
}
