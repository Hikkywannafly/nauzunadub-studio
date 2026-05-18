import { apiJson, apiPost } from './client';

export interface AppPrefs {
  llm_base_url: string;
  llm_model: string;
  llm_api_key_set: boolean;
  target_lang: string;
  tts_backend: string;
  asr_backend: string;
}

export interface PrefsUpdate {
  llm_base_url?: string;
  llm_model?: string;
  llm_api_key?: string;
  target_lang?: string;
  tts_backend?: string;
  asr_backend?: string;
}

export interface LlmTestResult {
  ok: boolean;
  detail: string;
  latency_ms: number;
}

export async function getPrefs(): Promise<AppPrefs> {
  return apiJson<AppPrefs>('/api/prefs');
}

export async function updatePrefs(body: PrefsUpdate): Promise<AppPrefs> {
  return apiJson<AppPrefs>('/api/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function testLlm(): Promise<LlmTestResult> {
  return apiPost<LlmTestResult>('/api/prefs/test-llm');
}

// Convenience presets for the Settings UI
export const LLM_PRESETS: { name: string; base_url: string; model: string; needs_key: boolean }[] = [
  { name: 'OpenAI', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needs_key: true },
  { name: 'Ollama (local)', base_url: 'http://localhost:11434/v1', model: 'qwen2.5:7b', needs_key: false },
  { name: 'LM Studio (local)', base_url: 'http://localhost:1234/v1', model: 'local-model', needs_key: false },
  { name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-sonnet', needs_key: true },
  { name: 'Groq', base_url: 'https://api.groq.com/openai/v1', model: 'llama-3.1-70b-versatile', needs_key: true },
];
