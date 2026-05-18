import { apiJson } from './client';

export interface TranslationGenre {
  id: string;
  label: string;
  description: string;
}

export async function listGenres(): Promise<TranslationGenre[]> {
  const data = await apiJson<{ genres: TranslationGenre[] }>('/api/genres');
  return data.genres || [];
}
