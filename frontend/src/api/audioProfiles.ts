import { apiJson } from './client';

export interface AudioProfile {
  id: string;
  label: string;
  description: string;
}

export async function listAudioProfiles(): Promise<AudioProfile[]> {
  const data = await apiJson<{ profiles: AudioProfile[] }>('/api/audio-profiles');
  return data.profiles || [];
}
