import React, { Suspense, lazy, useState, useEffect, useCallback, useRef } from 'react';
import {
  PanelLeftOpen, PanelLeftClose, FileText, Sparkles, Loader,
  ChevronDown, ChevronUp, Save,
} from 'lucide-react';
import { Mic2, SlidersHorizontal, Upload, Download as DownloadIcon } from 'lucide-react';
import DubSettingsModal from '../components/DubSettingsModal';
import WaveformTimeline from '../components/WaveformTimeline';
import CheckpointBanner from '../components/CheckpointBanner';
import { useAppStore } from '../store';
import { formatTime } from '../utils/format';
import { API } from '../api/client';
import { LANG_CODES } from '../utils/languages';
import toast from 'react-hot-toast';
import { Button, Segmented, Progress } from '../ui';
import GlossaryPanel from '../components/GlossaryPanel';
import ExportModal from '../components/ExportModal';
import VoiceSettings from './VoiceSettings';
import DubIdleSkeleton from '../components/DubIdleSkeleton';
import DubCastPanel from '../components/DubCastPanel';
import DubTranslationBar from '../components/DubTranslationBar';
import DubFooterPanel from '../components/DubFooterPanel';
import TimelineRebalanceBar from '../components/TimelineRebalanceBar';
import { fmtDur } from '../components/DubTabHelpers';
import './DubTab.css';

const DubSegmentTable = lazy(() => import('../components/DubSegmentTable'));

const LazyFallback = () => (
  <div className="dub-lazy-fallback">Loading…</div>
);

export default function DubTab(props) {
  const {
    dubVideoFile, dubLocalBlobUrl,
    transcribeElapsed, translateProvider, setTranslateProvider,
    translateGenre, setTranslateGenre,
    audioProfile, setAudioProfile,
    showTranscript, setShowTranscript,
    onGlossaryChange,
    profiles,
    segmentPreviewLoading,
    selectedSegIds,
    setDubVideoFile, setDubLocalBlobUrl,
    handleDubAbort, handleDubUpload, handleDubIngestUrl, handleDubRetryTranscribe, handleDubStop, handleDubGenerate, handleDubImportSrt,
    handleDubDownload, handleDubAudioDownload, handleAudioExport,
    speakerClones = {},
    handleSegmentPreview, onDirectSegment, handleTranslateAll, handleCleanupSegments,
    incrementalPlan,
    triggerDownload, fileToMediaUrl,
    editSegments, saveProject, resetDub,
    segmentEditField, segmentDelete, segmentRestoreOriginal, segmentSplit, segmentMerge,
    toggleSegSelect, selectAllSegs, clearSegSelection,
    bulkApplyToSelected, bulkDeleteSelected,
  } = props;

  // ── Voice Settings modal ──────────────────────────────────────────────────
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // ── Dub mix-time settings drawer ──────────────────────────────────────────
  const [showDubSettings, setShowDubSettings] = useState(false);

  // ── Store reads ───────────────────────────────────────────────────────────
  const dubJobId          = useAppStore(s => s.dubJobId);
  const dubStep           = useAppStore(s => s.dubStep);
  const dubFilename       = useAppStore(s => s.dubFilename);
  const dubDuration       = useAppStore(s => s.dubDuration);
  const dubSegments       = useAppStore(s => s.dubSegments);
  const dubTranscript     = useAppStore(s => s.dubTranscript);
  const dubLangCode       = useAppStore(s => s.dubLangCode);
  const dubLang           = useAppStore(s => s.dubLang);
  const dubTracks         = useAppStore(s => s.dubTracks);
  const dubProgress       = useAppStore(s => s.dubProgress);
  const isTranslating     = useAppStore(s => s.isTranslating);
  const preserveBg        = useAppStore(s => s.preserveBg);
  const setPreserveBg     = useAppStore(s => s.setPreserveBg);
  const defaultTrack      = useAppStore(s => s.defaultTrack);
  const setDefaultTrack   = useAppStore(s => s.setDefaultTrack);
  const exportTracks      = useAppStore(s => s.exportTracks);
  const setExportTracks   = useAppStore(s => s.setExportTracks);
  const dualSubs          = useAppStore(s => s.dualSubs);
  const setDualSubs       = useAppStore(s => s.setDualSubs);
  const burnSubs          = useAppStore(s => s.burnSubs);
  const setBurnSubs       = useAppStore(s => s.setBurnSubs);
  const activeProjectName     = useAppStore(s => s.activeProjectName);
  const isSidebarCollapsed    = useAppStore(s => s.isSidebarCollapsed);
  const setIsSidebarCollapsed = useAppStore(s => s.setIsSidebarCollapsed);
  const setDubSegments        = useAppStore(s => s.setDubSegments);

  // ── Segment optimize (bidirectional: shorten + expand) ───────────────────
  const [shorteningSegId, setShorteningSegId] = useState(null);
  const handleSegmentShorten = useCallback(async (seg) => {
    if (!seg) return;
    const slot = Math.max(0, (seg.end ?? 0) - (seg.start ?? 0));
    if (slot <= 0) {
      toast.error('Segment không có thời lượng — không optimize được.');
      return;
    }
    setShorteningSegId(seg.id);
    try {
      const { optimizeSegment } = await import('../api/segmentRate');
      const res = await optimizeSegment({
        text: seg.text || '',
        slot_seconds: slot,
        target_lang: (seg.target_lang || dubLangCode || 'vi').toLowerCase(),
        source_text: seg.text_original || undefined,
        genre_id: translateGenre || undefined,
      });
      if (res.error === 'no-llm') {
        toast.error('Chưa cấu hình LLM — vào Settings → LLM để bật.');
        return;
      }
      const wasOverflow = res.old_rate_ratio > 1.0;
      const action = wasOverflow ? 'rút' : 'expand';
      if (!res.text || res.text === seg.text) {
        toast(`LLM không ${action} thêm được. Vẫn ${res.rate_ratio.toFixed(2)}× slot. Thử Split hoặc edit tay.`, { icon: 'ℹ️' });
        return;
      }
      segmentEditField(seg.id, 'text', res.text);
      const msg = res.severity === 'ok'
        ? `✓ Đã ${action} (${res.old_rate_ratio.toFixed(2)}× → ${res.rate_ratio.toFixed(2)}×, ${res.attempts} lần thử)`
        : res.severity === 'warn'
          ? `⚠️ Đã ${action} nhưng vẫn hơi gấp (${res.old_rate_ratio.toFixed(2)}× → ${res.rate_ratio.toFixed(2)}×)`
          : res.severity === 'short'
            ? `🔵 Đã ${action} nhưng vẫn ngắn (${res.old_rate_ratio.toFixed(2)}× → ${res.rate_ratio.toFixed(2)}×)`
            : `🔴 Đã ${action} nhưng vẫn vượt (${res.old_rate_ratio.toFixed(2)}× → ${res.rate_ratio.toFixed(2)}×) — cân nhắc Split`;
      toast.success(msg);
    } catch (err) {
      toast.error(`Optimize thất bại: ${err.message || err}`);
    } finally {
      setShorteningSegId(null);
    }
  }, [dubLangCode, translateGenre, segmentEditField]);

  // ── Waveform seek ─────────────────────────────────────────────────────────
  const waveformRef = useRef(null);
  const seekWaveform = useCallback((time) => {
    waveformRef.current?.seekTo?.(time);
  }, []);

  // ── Generating overlay ETA ────────────────────────────────────────────────
  const [genElapsed, setGenElapsed] = useState(0);
  useEffect(() => {
    if (dubStep !== 'generating') { setGenElapsed(0); return; }
    const start = Date.now();
    setGenElapsed(0);
    const id = setInterval(() => setGenElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [dubStep]);
  const genRemaining = (() => {
    if (dubStep !== 'generating') return null;
    if (!dubProgress.total || !dubProgress.current || genElapsed < 2) return null;
    const perSeg = genElapsed / dubProgress.current;
    return Math.max(0, Math.round(perSeg * (dubProgress.total - dubProgress.current)));
  })();

  // ── Preview toggle ────────────────────────────────────────────────────────
  const [previewMode, setPreviewMode] = useState('original');
  const hasDubbedTrack = dubStep === 'done' && dubLangCode && dubLangCode !== 'und' && (dubTracks?.length > 0 || !!dubTracks);
  const videoSrc = (previewMode === 'dubbed' && hasDubbedTrack)
    ? `${API}/dub/preview-video/${dubJobId}?lang=${encodeURIComponent(dubLangCode)}&preserve_bg=${preserveBg ? 1 : 0}`
    : `${API}/dub/media/${dubJobId}`;

  // ── Glossary ──────────────────────────────────────────────────────────────
  const glossaryTermCount = useAppStore(s => s.glossaryTerms.length);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const glossaryVisible = glossaryOpen || glossaryTermCount > 0;

  // ── Checkpoint banner ─────────────────────────────────────────────────────
  const reviewMode = useAppStore(s => s.reviewMode);
  const [dismissedStages, setDismissedStages] = useState(() => new Set());
  const hasTranslations = dubSegments.some(s => s.text_original && s.text_original !== s.text);
  const checkpointStage =
    dubStep === 'editing' && !hasTranslations ? 'asr'
    : dubStep === 'editing' && hasTranslations ? 'translate'
    : dubStep === 'done' ? 'done'
    : null;
  const showCheckpoint = reviewMode === 'on' && checkpointStage && !dismissedStages.has(checkpointStage);
  const onCheckpointContinue = () => {
    if (checkpointStage === 'asr') handleTranslateAll?.();
    else if (checkpointStage === 'translate') handleDubGenerate?.();
  };
  const onCheckpointDismiss = () => {
    setDismissedStages(prev => {
      const next = new Set(prev);
      if (checkpointStage) next.add(checkpointStage);
      return next;
    });
  };

  const showIdleSkeleton = !(dubJobId && (dubStep === 'editing' || dubStep === 'generating' || dubStep === 'done'));

  return (
    <div className="dub-col">
      {/* ── Idle: drop zone + ghost skeleton ── */}
      {showIdleSkeleton && (
        <DubIdleSkeleton
          dubVideoFile={dubVideoFile}
          dubLocalBlobUrl={dubLocalBlobUrl}
          transcribeElapsed={transcribeElapsed}
          handleDubAbort={handleDubAbort}
          handleDubUpload={handleDubUpload}
          handleDubImportSrt={handleDubImportSrt}
          handleDubRetryTranscribe={handleDubRetryTranscribe}
          handleDubIngestUrl={handleDubIngestUrl}
          fileToMediaUrl={fileToMediaUrl}
          setDubVideoFile={setDubVideoFile}
          setDubLocalBlobUrl={setDubLocalBlobUrl}
        />
      )}

      {/* ── After transcription: side-by-side editor ── */}
      {dubJobId && (dubStep === 'editing' || dubStep === 'generating' || dubStep === 'done') && (
        <div className="dub-col">
          {/* Header */}
          <div className="dub-head">
            <div className="label-row dub-head__title">
              <Button
                variant="icon"
                iconSize="sm"
                active={isSidebarCollapsed}
                onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                title="Toggle Sidebar"
              >
                {isSidebarCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
              </Button>
              <FileText className="label-icon" size={11} />
              <span className="dub-head__filename">{dubFilename}</span>
              <span className="dub-head__meta">· {formatTime(dubDuration)} · {dubSegments.length} segs</span>
              {activeProjectName && activeProjectName !== dubFilename && (
                <span className="dub-head__project">— {activeProjectName}</span>
              )}
            </div>
            <div className="dub-head__actions">
              <Button
                variant="subtle"
                size="sm"
                onClick={() => setShowVoiceSettings(true)}
                leading={<Mic2 size={9} />}
                title="Gán giọng cho từng speaker"
                disabled={!dubSegments.length}
              >Voices</Button>
              <Button
                variant="subtle"
                size="sm"
                onClick={() => setShowDubSettings(true)}
                leading={<SlidersHorizontal size={9} />}
                title="Tinh chỉnh mix-time / slot-fit / TTS quality"
              >Settings</Button>
              <Button variant="subtle" size="sm" onClick={saveProject} leading={<Save size={9} />}>Save</Button>
              <Button variant="danger"  size="sm" onClick={resetDub}>Reset</Button>
            </div>
          </div>

          <div className="dub-split-grid dub-split-2">
            {/* LEFT: Waveform + CAST + Translation settings */}
            <div className="studio-panel dub-panel-col">
              {hasDubbedTrack && (
                <div className="dub-preview-toggle">
                  <span className="dub-preview-toggle__kicker">Preview</span>
                  <Segmented
                    size="sm"
                    value={previewMode}
                    onChange={setPreviewMode}
                    items={[
                      { value: 'original', label: 'Original' },
                      { value: 'dubbed',   label: `Dubbed (${dubLangCode})` },
                    ]}
                  />
                  {previewMode === 'dubbed' && (
                    <span className="dub-preview-toggle__hint">first play may take a moment to mux</span>
                  )}
                </div>
              )}

              <WaveformTimeline
                key={videoSrc}
                ref={waveformRef}
                audioSrc={`${API}/dub/audio/${dubJobId}`}
                videoSrc={videoSrc}
                segments={dubSegments}
                onSegmentsChange={setDubSegments}
                disabled={dubStep === 'generating' || dubStep === 'stopping'}
                overlayContent={(dubStep === 'generating' || dubStep === 'stopping') ? (
                  <div className="dub-gen-overlay">
                    <div className="dub-gen-overlay__head">
                      {dubStep === 'stopping'
                        ? <Loader className="spinner" size={14} color="#a89984" />
                        : <Sparkles className="spinner" size={14} color="#d3869b" />}
                      <span className={`dub-gen-overlay__title ${dubStep === 'stopping' ? 'is-stopping' : ''}`}>
                        {dubStep === 'stopping' ? 'Stopping…' : `Dubbing ${dubProgress.current}/${dubProgress.total}…`}
                      </span>
                    </div>
                    {dubStep === 'generating' && (
                      <>
                        <div className="dub-gen-overlay__stats">
                          <span>⏱ {fmtDur(genElapsed)} elapsed</span>
                          {genRemaining !== null && <span>~{fmtDur(genRemaining)} remaining</span>}
                        </div>
                        <div className="dub-gen-overlay__bar">
                          <Progress
                            value={dubProgress.total ? (dubProgress.current / dubProgress.total) * 100 : 0}
                            tone="brand"
                            size="sm"
                          />
                        </div>
                        {dubProgress.text && <span className="dub-gen-overlay__text">{dubProgress.text}</span>}
                      </>
                    )}
                  </div>
                ) : null}
              />

              <DubCastPanel
                speakerClones={speakerClones}
                profiles={profiles}
                audioProfile={audioProfile}
                setAudioProfile={setAudioProfile}
              />

              <DubTranslationBar
                translateProvider={translateProvider}
                setTranslateProvider={setTranslateProvider}
                translateGenre={translateGenre}
                setTranslateGenre={setTranslateGenre}
                editSegments={editSegments}
                handleTranslateAll={handleTranslateAll}
                handleCleanupSegments={handleCleanupSegments}
              />
            </div>

            {/* RIGHT: Transcript + Glossary + Bulk select + Segment table */}
            <div className="studio-panel dub-panel-col">
              {dubTranscript && (
                <div className="dub-transcript-toggle-wrap">
                  <div
                    className="override-toggle dub-transcript-toggle__inner"
                    onClick={() => setShowTranscript(!showTranscript)}
                  >
                    <span><FileText size={10} className="dub-inline-icon" /> Transcript</span>
                    {showTranscript ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                  </div>
                  {showTranscript && (
                    <div className="dub-transcript-body">{dubTranscript}</div>
                  )}
                </div>
              )}

              {dubJobId && !glossaryVisible && (
                <button
                  type="button"
                  className="dub-glossary-chip"
                  onClick={() => setGlossaryOpen(true)}
                  title="Pin translations for recurring terms (names, brand words, jargon)"
                >
                  + Glossary (0)
                </button>
              )}
              {dubJobId && glossaryVisible && (
                <div className="dub-glossary-wrap">
                  <GlossaryPanel
                    projectId={dubJobId}
                    sourceLang={dubLangCode && dubLang ? (dubLang.slice(0, 2).toLowerCase() || 'en') : 'en'}
                    targetLang={dubLangCode}
                    segments={dubSegments}
                    onChange={onGlossaryChange}
                  />
                </div>
              )}

              {selectedSegIds.size > 0 && (
                <div className="dub-bulk-row dub-bulk-row--select">
                  <span className="dub-bulk-row__label-brand">{selectedSegIds.size} selected</span>
                  <select
                    className="input-base dub-bulk-select dub-bulk-select--voice"
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '__clear__') bulkApplyToSelected({ profile_id: '' });
                      else if (v) bulkApplyToSelected({ profile_id: v });
                    }}
                  >
                    <option value="">Set voice…</option>
                    <option value="__clear__">⊘ Default</option>
                    {speakerClones && Object.keys(speakerClones).length > 0 && (
                      <optgroup label="From Video">
                        {Object.keys(speakerClones).map(spk => {
                          const autoId = `auto:${(spk || '').toLowerCase().replace(/\s+/g, '_')}`;
                          return <option key={autoId} value={autoId}>🎤 {spk}</option>;
                        })}
                      </optgroup>
                    )}
                    {profiles.filter(p => !p.instruct).length > 0 && (
                      <optgroup label="Clone">
                        {profiles.filter(p => !p.instruct).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </optgroup>
                    )}
                    {profiles.filter(p => !!p.instruct).length > 0 && (
                      <optgroup label="Designed">
                        {profiles.filter(p => !!p.instruct).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </optgroup>
                    )}
                  </select>
                  <select
                    className="input-base dub-bulk-select dub-bulk-select--lang"
                    value=""
                    onChange={(e) => {
                      if (e.target.value === '__def__') bulkApplyToSelected({ target_lang: null });
                      else if (e.target.value) bulkApplyToSelected({ target_lang: e.target.value });
                    }}
                  >
                    <option value="">Set lang…</option>
                    <option value="__def__">(Default)</option>
                    {LANG_CODES.map(lc => <option key={lc.code} value={lc.code}>{lc.code.toUpperCase()}</option>)}
                  </select>
                  <Button variant="danger" size="sm" onClick={bulkDeleteSelected}>Delete</Button>
                  <Button variant="ghost"  size="sm" onClick={clearSegSelection} className="dub-bulk-row__clear">Clear</Button>
                </div>
              )}

              {showCheckpoint && (
                <CheckpointBanner
                  stage={checkpointStage}
                  count={dubSegments.length}
                  onContinue={checkpointStage === 'done' ? null : onCheckpointContinue}
                  onDismiss={onCheckpointDismiss}
                  continueLoading={isTranslating}
                />
              )}

              <div className="dub-segments-toolbar">
                <TranscriptIO
                  jobId={dubJobId}
                  filename={dubFilename}
                  hasSegments={dubSegments.length > 0}
                  onImport={handleDubImportSrt}
                />
                <TimelineRebalanceBar />
              </div>

              <Suspense fallback={<LazyFallback />}>
                <DubSegmentTable
                  segments={dubSegments}
                  profiles={profiles}
                  speakerClones={speakerClones}
                  dubStep={dubStep}
                  dubProgress={dubProgress}
                  previewLoadingId={segmentPreviewLoading}
                  selectedIds={selectedSegIds}
                  onSelect={toggleSegSelect}
                  onSelectAll={selectAllSegs}
                  onClearSelection={clearSegSelection}
                  onEditField={segmentEditField}
                  onDelete={segmentDelete}
                  onRestore={segmentRestoreOriginal}
                  onPreview={handleSegmentPreview}
                  onDirect={onDirectSegment}
                  onSplit={segmentSplit}
                  onMerge={segmentMerge}
                  onSeek={seekWaveform}
                  onShorten={handleSegmentShorten}
                  dubLangCode={dubLangCode}
                  shorteningId={shorteningSegId}
                />
              </Suspense>
            </div>
          </div>

          <DubFooterPanel
            incrementalPlan={incrementalPlan}
            handleDubGenerate={handleDubGenerate}
            handleDubStop={handleDubStop}
            onExportOpen={() => setExportOpen(true)}
          />
        </div>
      )}

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        jobId={dubJobId}
        filename={dubFilename}
        dubTracks={dubTracks}
        dubLangCode={dubLangCode}
        preserveBg={preserveBg}        setPreserveBg={setPreserveBg}
        defaultTrack={defaultTrack}    setDefaultTrack={setDefaultTrack}
        exportTracks={exportTracks}    setExportTracks={setExportTracks}
        dualSubs={dualSubs}            setDualSubs={setDualSubs}
        burnSubs={burnSubs}            setBurnSubs={setBurnSubs}
        API={API}
        triggerDownload={triggerDownload}
        handleDubDownload={handleDubDownload}
        handleDubAudioDownload={handleDubAudioDownload}
        handleAudioExport={handleAudioExport}
        segmentCount={dubSegments.length}
        onEnterprise={() => useAppStore.getState().setMode?.('enterprise')}
      />

      {showVoiceSettings && (
        <div
          className="voice-settings-overlay"
          onClick={(e) => { if (e.target === e.currentTarget) setShowVoiceSettings(false); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 9000, padding: '32px',
          }}
        >
          <div
            style={{
              background: 'var(--surface-1, #1d2021)',
              borderRadius: '12px',
              maxWidth: '1100px',
              width: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            }}
          >
            <VoiceSettings
              jobId={dubJobId}
              onContinue={() => {
                setShowVoiceSettings(false);
                if (dubStep === 'editing') handleDubGenerate?.();
              }}
              onBack={() => setShowVoiceSettings(false)}
            />
          </div>
        </div>
      )}

      <DubSettingsModal
        open={showDubSettings}
        onClose={() => setShowDubSettings(false)}
      />
    </div>
  );
}

function TranscriptIO({ jobId, filename, hasSegments, onImport }) {
  const onPickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.srt,text/plain,application/x-subrip';
    input.onchange = (e) => {
      const f = e.target.files?.[0];
      if (f) onImport?.(f);
    };
    input.click();
  };

  const onExport = () => {
    if (!jobId || !hasSegments) return;
    // GET /dub/srt/{job_id} renders current segments → SRT. Trigger browser
    // download via anchor click; backend sets Content-Disposition filename.
    const baseName = (filename || 'transcript').replace(/\.[^.]+$/, '');
    const url = `${API}/dub/srt/${jobId}/${encodeURIComponent(baseName)}.srt`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.srt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="dub-transcript-io">
      <button
        type="button"
        className="dub-transcript-io__btn"
        onClick={onPickFile}
        title="Import transcript .srt — thay thế segments hiện tại"
      >
        <Upload size={11} /> Import .srt
      </button>
      <button
        type="button"
        className="dub-transcript-io__btn"
        onClick={onExport}
        disabled={!jobId || !hasSegments}
        title="Xuất segments thành .srt (round-trip với Import)"
      >
        <DownloadIcon size={11} /> Export .srt
      </button>
    </div>
  );
}
