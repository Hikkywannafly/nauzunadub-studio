import { useEffect, useState } from 'react';
import { Check, X, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { getPrefs, updatePrefs, testLlm, LLM_PRESETS } from '../api/prefs';

/**
 * LLMProviderSettings — UI cấu hình LLM provider (cho translation).
 *
 * Hỗ trợ OpenAI, Ollama local, LM Studio, OpenRouter, Groq, hoặc custom
 * OpenAI-compatible base_url. Lưu qua /api/prefs (JSON file ở DATA_DIR).
 */
export default function LLMProviderSettings() {
  const [prefs, setPrefsState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKeyEditor, setShowKeyEditor] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getPrefs()
      .then((p) => {
        if (!cancelled) setPrefsState(p);
      })
      .catch((e) => toast.error(`Failed to load prefs: ${e.message || e}`))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading || !prefs) {
    return <div className="p-4 text-sm text-muted-foreground">Đang tải…</div>;
  }

  async function save(patch) {
    setSaving(true);
    try {
      const next = await updatePrefs(patch);
      setPrefsState(next);
      toast.success('Đã lưu cấu hình LLM');
      setTestResult(null);
    } catch (e) {
      toast.error(`Save failed: ${e.message || e}`);
    } finally {
      setSaving(false);
    }
  }

  function applyPreset(preset) {
    save({ llm_base_url: preset.base_url, llm_model: preset.model });
  }

  async function handleTest() {
    setTestResult({ loading: true });
    try {
      const r = await testLlm();
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, detail: e.message || String(e), latency_ms: 0 });
    }
  }

  function saveApiKey() {
    save({ llm_api_key: apiKeyInput });
    setApiKeyInput('');
    setShowKeyEditor(false);
  }

  return (
    <div className="llm-provider-settings space-y-4 max-w-2xl">
      <div>
        <h3 className="text-lg font-semibold mb-1">LLM Provider</h3>
        <p className="text-sm text-muted-foreground">
          Dùng cho dịch (Translate) và voice direction. Hỗ trợ OpenAI, Ollama local, LM Studio, OpenRouter…
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Preset</label>
        <div className="flex flex-wrap gap-2">
          {LLM_PRESETS.map((p) => {
            const active = prefs.llm_base_url === p.base_url;
            return (
              <button
                key={p.name}
                onClick={() => applyPreset(p)}
                disabled={saving}
                className={`px-3 py-1.5 rounded border text-sm ${
                  active ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'
                }`}
              >
                {p.name}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Base URL</label>
        <input
          type="text"
          value={prefs.llm_base_url}
          onChange={(e) => setPrefsState({ ...prefs, llm_base_url: e.target.value })}
          onBlur={(e) => save({ llm_base_url: e.target.value })}
          className="w-full border rounded px-2 py-1.5 bg-background"
          placeholder="https://api.openai.com/v1"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Model</label>
        <input
          type="text"
          value={prefs.llm_model}
          onChange={(e) => setPrefsState({ ...prefs, llm_model: e.target.value })}
          onBlur={(e) => save({ llm_model: e.target.value })}
          className="w-full border rounded px-2 py-1.5 bg-background"
          placeholder="gpt-4o-mini"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">API Key</label>
        {!showKeyEditor ? (
          <div className="flex items-center gap-2 text-sm">
            <span
              className={`px-2 py-0.5 rounded ${
                prefs.llm_api_key_set
                  ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {prefs.llm_api_key_set ? '✓ Đã cấu hình' : 'Chưa cấu hình'}
            </span>
            <button onClick={() => setShowKeyEditor(true)} className="text-primary hover:underline">
              {prefs.llm_api_key_set ? 'Đổi key' : 'Thêm key'}
            </button>
            {prefs.llm_api_key_set && (
              <button
                onClick={() => save({ llm_api_key: '' })}
                className="text-red-500 hover:underline"
              >
                Xoá
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="password"
              autoFocus
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              className="flex-1 border rounded px-2 py-1.5 bg-background"
              placeholder="sk-…"
            />
            <button
              onClick={saveApiKey}
              disabled={!apiKeyInput || saving}
              className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm"
            >
              Lưu
            </button>
            <button
              onClick={() => {
                setShowKeyEditor(false);
                setApiKeyInput('');
              }}
              className="px-3 py-1.5 rounded border text-sm"
            >
              Huỷ
            </button>
          </div>
        )}
        <div className="text-xs text-muted-foreground mt-1">
          Với Ollama / LM Studio chạy local, bỏ trống cũng được.
        </div>
      </div>

      <div className="border-t pt-4">
        <button
          onClick={handleTest}
          disabled={testResult?.loading}
          className="px-3 py-1.5 rounded border hover:bg-muted text-sm flex items-center gap-2"
        >
          {testResult?.loading ? <RefreshCw size={14} className="animate-spin" /> : null}
          Test kết nối
        </button>
        {testResult && !testResult.loading && (
          <div
            className={`mt-2 p-2 rounded text-sm flex items-center gap-2 ${
              testResult.ok
                ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
            }`}
          >
            {testResult.ok ? <Check size={16} /> : <X size={16} />}
            <span>
              {testResult.detail}
              {testResult.ok && ` (${testResult.latency_ms}ms)`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
