import React, { useState, useCallback, useEffect } from 'react';
import { Languages, ChevronDown, ChevronUp, Wand2, Globe, UserSquare2 } from 'lucide-react';
import { useAppStore } from '../store';
import { Button, Segmented } from '../ui';
import MultiLangPicker from './MultiLangPicker';
import TranslationHistoryPicker from './TranslationHistoryPicker';
import ALL_LANGUAGES from '../languages.json';
import { POPULAR_LANGS } from '../utils/constants';
import { LANG_CODES } from '../utils/languages';
import { listTranslationEngines, installTranslationEngine } from '../api/engines';
import toast from 'react-hot-toast';

export default function DubTranslationBar({
  translateProvider,
  setTranslateProvider,
  translateGenre,
  setTranslateGenre,
  editSegments,
  handleTranslateAll,
  handleCleanupSegments,
}) {
  const dubLang           = useAppStore(s => s.dubLang);
  const setDubLang        = useAppStore(s => s.setDubLang);
  const dubLangCode       = useAppStore(s => s.dubLangCode);
  const setDubLangCode    = useAppStore(s => s.setDubLangCode);
  const dubInstruct       = useAppStore(s => s.dubInstruct);
  const setDubInstruct    = useAppStore(s => s.setDubInstruct);
  const translateQuality  = useAppStore(s => s.translateQuality);
  const setTranslateQuality = useAppStore(s => s.setTranslateQuality);
  const isTranslating     = useAppStore(s => s.isTranslating);
  const dubSegments       = useAppStore(s => s.dubSegments);
  const dubJobId          = useAppStore(s => s.dubJobId);
  const dubStep           = useAppStore(s => s.dubStep);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [genres, setGenres] = useState([]);
  const [engines, setEngines] = useState([]);
  const [enginesSandboxed, setEnginesSandboxed] = useState(false);
  const [engineInstalling, setEngineInstalling] = useState(null);
  const [multiLangMode, setMultiLangMode] = useState(false);
  const [multiLangs, setMultiLangs] = useState([]);

  const hasAnyTranslation = dubSegments.some(s => s.text_original && s.text_original !== s.text);

  const refreshEngines = useCallback(async () => {
    try {
      const res = await listTranslationEngines();
      setEngines(res.engines || []);
      setEnginesSandboxed(!!res.sandboxed);
    } catch {
      setEngines([]);
    }
  }, []);

  useEffect(() => { refreshEngines(); }, [refreshEngines]);

  useEffect(() => {
    (async () => {
      try {
        const { listGenres } = await import('../api/genres');
        setGenres(await listGenres());
      } catch {
        setGenres([]);
      }
    })();
  }, []);

  const activeEngineEntry      = engines.find(e => e.id === translateProvider);
  const activeEngineUnavailable = activeEngineEntry && !activeEngineEntry.installed;

  const handleInstallEngine = async (engineId) => {
    if (!engineId || enginesSandboxed) return;
    setEngineInstalling(engineId);
    const progressToast = toast.loading(`Installing ${engineId}…`);
    try {
      const res = await installTranslationEngine(engineId);
      await refreshEngines();
      if (res.restart_required) {
        toast(`${engineId} installed. Restart the backend to load it.`, { icon: '🔄', id: progressToast, duration: 7000 });
      } else if (res.status === 'already_installed') {
        toast(`${engineId} was already installed`, { icon: 'ℹ️', id: progressToast });
      } else {
        toast.success(`${engineId} installed`, { id: progressToast });
      }
    } catch (err) {
      toast.error(`Install failed: ${String(err.message || err).slice(0, 200)}`, { id: progressToast, duration: 8000 });
    } finally {
      setEngineInstalling(null);
    }
  };

  if (!settingsOpen) {
    return (
      <div className="dub-settings-summary">
        <button
          type="button"
          className="dub-settings-summary__trigger"
          onClick={() => setSettingsOpen(true)}
          title="Edit translation settings"
        >
          <ChevronDown size={10} />
          <span><strong>{dubLang}</strong> · {dubLangCode} · {translateQuality} · {translateProvider}</span>
          {dubInstruct && <span className="dub-settings-summary__style">style: {dubInstruct}</span>}
        </button>
        <Button
          variant="subtle" size="sm"
          onClick={handleTranslateAll}
          disabled={isTranslating || !dubSegments.length}
          loading={isTranslating}
          leading={!isTranslating && <Languages size={10} />}
        >
          {isTranslating ? 'Translating…' : hasAnyTranslation ? 'Re-translate' : 'Translate All'}
        </Button>
        <TranslationHistoryPicker size="sm" />
        <Button
          variant="subtle" size="sm"
          onClick={handleCleanupSegments}
          disabled={!dubSegments.length || !dubJobId}
          title="Merge tiny fragments and adjacent short segments"
          leading={<Wand2 size={10} />}
        >
          Clean Up
        </Button>
      </div>
    );
  }

  return (
    <div className="dub-settings-bar">
      <div className="dub-settings-bar__fields">
        <button
          type="button"
          className="dub-settings-summary__trigger dub-settings-close"
          onClick={() => setSettingsOpen(false)}
          title="Collapse translation settings"
        >
          <ChevronUp size={10} />
        </button>

        <div className="dub-settings-field dub-settings-field--lang">
          <div className="label-row"><Globe className="label-icon" size={9} /> Language</div>
          <select
            className="input-base dub-cast__select"
            value={dubLang}
            onChange={(e) => {
              const lang = e.target.value;
              setDubLang(lang);
              const match = LANG_CODES.find(lc => lc.label.toLowerCase() === lang.toLowerCase());
              if (match) setDubLangCode(match.code);
            }}
          >
            <optgroup label="Popular">
              {POPULAR_LANGS.map(l => <option key={`p-${l}`} value={l}>{l}</option>)}
            </optgroup>
            <optgroup label="All languages">
              {ALL_LANGUAGES
                .filter(l => !POPULAR_LANGS.includes(l))
                .map(l => <option key={l} value={l}>{l}</option>)}
            </optgroup>
          </select>
        </div>

        <div className="dub-settings-field dub-settings-field--iso">
          <div className="label-row">ISO</div>
          <select
            className="input-base"
            value={dubLangCode}
            onChange={(e) => setDubLangCode(e.target.value)}
            title={LANG_CODES.find(lc => lc.code === dubLangCode)?.label || ''}
          >
            {LANG_CODES.map(lc => (
              <option key={lc.code} value={lc.code} title={lc.label}>{lc.code}</option>
            ))}
          </select>
        </div>

        <div className="dub-settings-field dub-settings-field--engine">
          <div className="label-row">
            Engine
            {activeEngineUnavailable && !enginesSandboxed && (
              <button
                type="button"
                className="dub-engine-install-chip"
                onClick={() => handleInstallEngine(translateProvider)}
                disabled={engineInstalling === translateProvider}
                title={activeEngineEntry?.notes || 'Install this engine'}
              >
                {engineInstalling === translateProvider ? '…installing' : `+ install ${activeEngineEntry?.pip_package || ''}`}
              </button>
            )}
            {activeEngineUnavailable && enginesSandboxed && (
              <span className="dub-engine-install-chip dub-engine-install-chip--disabled" title="Installs are disabled in packaged builds">
                needs dev install
              </span>
            )}
          </div>
          <select
            className="input-base dub-engine-select"
            value={translateProvider}
            onChange={e => setTranslateProvider(e.target.value)}
          >
            {[{ id: 'openai', display_name: 'LLM (OpenAI-compatible)', installed: true }].map(p => (
              <option key={p.id} value={p.id}>
                {p.installed ? p.display_name : `${p.display_name} — needs install`}
              </option>
            ))}
          </select>
        </div>

        <div className="dub-settings-field dub-settings-field--genre">
          <div className="label-row" title="Style preset cho LLM — đại từ, giọng văn, slang khớp với thể loại nội dung.">Genre</div>
          <select
            className="input-base dub-engine-select"
            value={translateGenre || ''}
            onChange={e => setTranslateGenre(e.target.value)}
            title={genres.find(g => g.id === translateGenre)?.description || 'Không pick = prompt mặc định'}
          >
            <option value="">— Mặc định —</option>
            {genres.map(g => (
              <option key={g.id} value={g.id} title={g.description}>{g.label}</option>
            ))}
          </select>
        </div>

        <div className="dub-settings-field dub-settings-field--quality">
          <div className="label-row" title="Cinematic = 3-step LLM refinement (translate → reflect → adapt). Needs an LLM configured.">Quality</div>
          <Segmented
            size="sm"
            value={translateQuality}
            onChange={setTranslateQuality}
            items={[
              { value: 'fast',      label: 'Fast' },
              { value: 'cinematic', label: 'Cinematic' },
            ]}
          />
        </div>

        <div className="dub-settings-field dub-settings-field--style">
          <div className="label-row">
            <UserSquare2 className="label-icon" size={9} /> Style <span className="dub-settings-field__hint">optional</span>
          </div>
          <input
            className="input-base input-base--xs"
            placeholder="e.g. female"
            value={dubInstruct}
            onChange={e => setDubInstruct(e.target.value)}
          />
        </div>

        <div className="dub-settings-field dub-settings-field--multi">
          <label className="dub-multi-toggle">
            <input
              type="checkbox"
              checked={multiLangMode}
              onChange={e => setMultiLangMode(e.target.checked)}
            />
            <span>Multi-lang</span>
          </label>
          {multiLangMode && (
            <MultiLangPicker
              selected={multiLangs}
              onChange={setMultiLangs}
              disabled={dubStep === 'generating'}
            />
          )}
        </div>
      </div>

      <div className="dub-settings-bar__actions">
        <Button
          variant="subtle" size="sm"
          onClick={() => editSegments(dubSegments.map(s => ({ ...s, text: s.text_original || s.text, translate_error: undefined })))}
          disabled={!dubSegments.some(s => s.text_original && s.text_original !== s.text)}
          title="Restore all segments to the original transcribed text"
        >
          ↺ Restore
        </Button>
        <Button
          variant="subtle" size="sm"
          onClick={handleCleanupSegments}
          disabled={!dubSegments.length || !dubJobId}
          title="Merge tiny fragments and adjacent short segments"
          leading={<Wand2 size={10} />}
        >
          Clean Up
        </Button>
        <TranslationHistoryPicker size="sm" />
        <Button
          variant="primary" size="sm"
          onClick={handleTranslateAll}
          disabled={isTranslating || !dubSegments.length}
          loading={isTranslating}
          leading={!isTranslating && <Languages size={10} />}
        >
          {isTranslating ? 'Translating…' : 'Translate All'}
        </Button>
      </div>
    </div>
  );
}
