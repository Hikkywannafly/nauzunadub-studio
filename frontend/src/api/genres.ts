import { apiJson } from './client';

export interface TranslationGenre {
  id: string;
  label: string;
  description: string;
  // Fields below come from skill MD files (`backend/skills/translate/*.md`)
  // and are absent for the hardcoded Python fallback genres.
  source_languages?: string[];
  version?: string;
  author?: string;
}

export async function listGenres(): Promise<TranslationGenre[]> {
  const data = await apiJson<{ genres: TranslationGenre[] }>('/api/genres');
  return data.genres || [];
}

/** Force backend to re-scan `backend/skills/translate/` after edits. */
export async function reloadSkills(): Promise<TranslationGenre[]> {
  const data = await apiJson<{ skills: TranslationGenre[] }>('/api/skills/translate/reload', { method: 'POST' });
  return data.skills || [];
}
