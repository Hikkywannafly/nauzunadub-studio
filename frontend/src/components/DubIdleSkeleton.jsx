import React, { useState } from 'react';
import {
  PanelLeftOpen, PanelLeftClose, Film, Save, UploadCloud, Sparkles, Loader,
  FileText, Link2, Languages, ChevronDown, UserSquare2, Globe, AlertCircle,
  Trash2, Play, Volume2,
} from 'lucide-react';
import { Download } from 'lucide-react';
import WaveformTimeline from './WaveformTimeline';
import { useAppStore } from '../store';
import { Button, Badge } from '../ui';
import { PrepOverlay, TranscribeOverlay } from './DubTabHelpers';

export default function DubIdleSkeleton({
  dubVideoFile,
  dubLocalBlobUrl,
  transcribeElapsed,
  handleDubAbort,
  handleDubUpload,
  handleDubImportSrt,
  handleDubRetryTranscribe,
  handleDubIngestUrl,
  fileToMediaUrl,
  setDubVideoFile,
  setDubLocalBlobUrl,
}) {
  const dubJobId          = useAppStore(s => s.dubJobId);
  const dubStep           = useAppStore(s => s.dubStep);
  const setDubStep        = useAppStore(s => s.setDubStep);
  const dubPrepStage      = useAppStore(s => s.dubPrepStage);
  const dubFilename       = useAppStore(s => s.dubFilename);
  const dubDuration       = useAppStore(s => s.dubDuration);
  const dubError          = useAppStore(s => s.dubError);
  const activeProjectName = useAppStore(s => s.activeProjectName);
  const isSidebarCollapsed    = useAppStore(s => s.isSidebarCollapsed);
  const setIsSidebarCollapsed = useAppStore(s => s.setIsSidebarCollapsed);

  const [ingestUrl, setIngestUrl] = useState('');
  const [fetchYtSubs, setFetchYtSubs] = useState(false);

  const onIngestUrl = () => {
    if (!ingestUrl.trim() || !handleDubIngestUrl) return;
    handleDubIngestUrl(ingestUrl.trim(), { fetchSubs: fetchYtSubs });
    setIngestUrl('');
  };

  return (
    <div className="dub-col">
      {/* Header bar */}
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
          <Film className="label-icon" size={11} />
          <span className="dub-head__filename">{dubVideoFile ? dubVideoFile.name : 'Video Dubbing Studio'}</span>
          {dubVideoFile && <span className="dub-head__meta">· {(dubVideoFile.size / 1024 / 1024).toFixed(1)} MB</span>}
          {activeProjectName && activeProjectName !== dubFilename && (
            <span className="dub-head__project">— {activeProjectName}</span>
          )}
        </div>
        <div className="dub-head__actions">
          <Button variant="subtle" size="sm" disabled leading={<Save size={9} />}>Save</Button>
          <Button variant="ghost"  size="sm" disabled>Reset</Button>
        </div>
      </div>

      {/* Transcription failure banner */}
      {dubError && dubJobId && dubStep === 'idle' && (
        <div className="dub-footer-banner">
          <Badge tone="danger">
            <AlertCircle size={11} /> {dubError}
          </Badge>
          {handleDubRetryTranscribe && (
            <Button
              variant="subtle"
              size="sm"
              onClick={handleDubRetryTranscribe}
              leading={<Sparkles size={10} />}
            >
              Retry transcription
            </Button>
          )}
          {handleDubImportSrt && (
            <label
              htmlFor="srt-import-banner-input"
              className="dub-idle-upload-label"
              title="Upload your own .srt to bypass ASR"
              style={{ cursor: 'pointer' }}
            >
              <FileText size={11} /> Import .srt instead
              <input
                id="srt-import-banner-input"
                type="file"
                accept=".srt,text/srt,text/plain"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleDubImportSrt(f);
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>
      )}

      <div className={`dub-split-grid ${dubVideoFile ? 'dub-split-2' : 'dub-split-1'}`}>
        {/* LEFT — waveform preview or drop zone */}
        <div className="studio-panel dub-panel-col">
          {dubVideoFile ? (
            <>
              <WaveformTimeline
                audioSrc={dubLocalBlobUrl?.audioUrl}
                videoSrc={dubLocalBlobUrl?.videoUrl}
                segments={[]}
                onSegmentsChange={() => {}}
                disabled={true}
                overlayContent={
                  dubStep === 'uploading' ? (
                    <PrepOverlay stage={dubPrepStage} onAbort={handleDubAbort} />
                  ) : dubStep === 'transcribing' ? (
                    <TranscribeOverlay
                      elapsed={transcribeElapsed}
                      duration={dubDuration}
                      onAbort={handleDubAbort}
                    />
                  ) : null
                }
              />
              <div className="dub-change-row">
                <label htmlFor="video-upload" className="dub-idle-upload-label">
                  <Film size={13} /> Change file
                </label>
                {dubJobId && handleDubImportSrt && (
                  <label
                    htmlFor="srt-import-input"
                    className="dub-idle-upload-label"
                    title="Use your own .srt subtitles instead of running Whisper transcription"
                    style={{ cursor: 'pointer' }}
                  >
                    <FileText size={13} /> Import .srt
                    <input
                      id="srt-import-input"
                      type="file"
                      accept=".srt,text/srt,text/plain"
                      hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleDubImportSrt(f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}
                <button
                  className="btn-primary dub-change-row__cta"
                  onClick={handleDubUpload}
                  disabled={dubStep === 'uploading' || dubStep === 'transcribing'}
                >
                  {dubStep === 'uploading' || dubStep === 'transcribing'
                    ? <><Loader className="spinner" size={14} /> Processing…</>
                    : <><Sparkles size={14} /> Upload &amp; Transcribe</>}
                </button>
              </div>
            </>
          ) : dubStep === 'uploading' ? (
            <PrepOverlay stage={dubPrepStage} onAbort={handleDubAbort} large />
          ) : (
            <label
              htmlFor="video-upload"
              className="dub-idle-drop"
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('is-dragging'); }}
              onDragLeave={e => { e.currentTarget.classList.remove('is-dragging'); }}
              onDrop={e => {
                e.preventDefault();
                e.currentTarget.classList.remove('is-dragging');
                const file = e.dataTransfer.files[0];
                if (file && (file.type.startsWith('video/') || file.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|ogg)$/i.test(file.name))) {
                  setDubVideoFile(file);
                  setDubStep('idle');
                  fileToMediaUrl(file, null).then(urls => setDubLocalBlobUrl(urls));
                }
              }}
            >
              <div className="dub-idle-drop__puck">
                <UploadCloud color="#d3869b" size={28} />
              </div>
              <div className="dub-idle-drop__lines">
                <div className="dub-idle-drop__title">Drop video or audio here</div>
                <div className="dub-idle-drop__sub">MP4 · MOV · MKV · WEBM · MP3 · WAV · FLAC · M4A</div>
              </div>
              <div className="dub-ingest-row" onClick={e => e.preventDefault()}>
                <Link2 size={13} color="#a89984" />
                <input
                  type="text"
                  placeholder="…or paste YouTube / video URL"
                  value={ingestUrl}
                  onChange={e => setIngestUrl(e.target.value)}
                  onClick={e => { e.preventDefault(); e.stopPropagation(); }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onIngestUrl(); } }}
                  className="dub-ingest-row__input"
                />
                <button
                  type="button"
                  onClick={e => { e.preventDefault(); e.stopPropagation(); onIngestUrl(); }}
                  disabled={!ingestUrl.trim()}
                  className={`dub-ingest-row__cta ${ingestUrl.trim() ? 'is-ready' : ''}`}
                >
                  Ingest
                </button>
              </div>
              <label
                className="dub-ingest-sub-opt"
                title="When the URL is a caption-bearing host (YouTube, Vimeo, TED…), also pull the original captions and any YouTube auto-translations. Seeds the editor without running Whisper; skip Translate All for languages YouTube already covers."
                onClick={e => { e.stopPropagation(); }}
              >
                <input
                  type="checkbox"
                  checked={fetchYtSubs}
                  onChange={e => setFetchYtSubs(e.target.checked)}
                  onClick={e => e.stopPropagation()}
                />
                <span>Pull YouTube captions + auto-translations</span>
              </label>
            </label>
          )}

          <input
            type="file"
            accept="video/*,audio/*,.mp3,.wav,.m4a,.flac,.ogg"
            id="video-upload"
            className="dub-hidden-file"
            onChange={e => {
              const file = e.target.files[0];
              if (!file) return;
              setDubVideoFile(file);
              setDubStep('idle');
              setDubLocalBlobUrl(prev => { fileToMediaUrl(file, prev).then(urls => setDubLocalBlobUrl(urls)); return prev; });
            }}
          />

          <div className="dub-cast dub-cast--muted">
            <div className="dub-cast__row">
              <span className="dub-cast__kicker">CAST</span>
              <span className="dub-cast__label">Speaker 1:</span>
              <span className="dub-cast--muted__chip">Default</span>
            </div>
          </div>
        </div>

        {/* RIGHT — ghost settings skeleton (only when a file is loaded) */}
        {dubVideoFile ? (
          <div className="studio-panel dub-panel-col">
            <div className="dub-skel-settings">
              <div className="dub-skel-field">
                <div className="label-row"><Globe className="label-icon" size={9} /> Language</div>
                <select className="input-base input-base--xs" disabled>
                  <option>Auto</option>
                </select>
              </div>
              <div className="dub-skel-field--sm">
                <div className="label-row">ISO Code</div>
                <select className="input-base input-base--xs" disabled>
                  <option>en — English</option>
                </select>
              </div>
              <div className="dub-skel-field">
                <div className="label-row"><UserSquare2 className="label-icon" size={9} /> Style</div>
                <input className="input-base input-base--xs" disabled placeholder="e.g. female" />
              </div>
              <button disabled className="dub-skel-translate-btn">
                <Languages size={10} /> Translate All
              </button>
            </div>
            <div className="dub-skel-transcript-toggle">
              <div className="override-toggle dub-skel-transcript-toggle__inner">
                <span><FileText size={10} className="dub-inline-icon" /> Transcript</span>
                <ChevronDown size={10} />
              </div>
            </div>
            <div className="segment-table dub-skel-table">
              <div className="segment-header">
                <span className="dub-skel-header-time">Time</span>
                <span className="dub-skel-header-spkr">Spkr</span>
                <span className="dub-skel-header-text">Text</span>
                <span className="dub-skel-header-voice">Voice</span>
                <span className="dub-skel-header-acts"></span>
              </div>
              {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
                <div key={i} className="segment-row" style={{ opacity: 0.15 + (0.04 * (8 - i)) }}>
                  <span className="segment-time dub-skel-cell-time">0:00.0–0:00.0</span>
                  <span className="dub-skel-cell-spkr">Speaker 1</span>
                  <div className="dub-skel-cell-text" />
                  <span className="dub-skel-cell-voice">Default</span>
                  <div className="dub-skel-cell-acts">
                    <span className="segment-del dub-skel-cell-acts__icon"><Trash2 size={9} /></span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* Ghost footer */}
      <div className="studio-panel dub-ghost-footer">
        <div className="dub-skel-gen-row">
          <button className="btn-primary dub-skel-gen-btn" disabled>
            <Play size={11} /> Generate Dub
          </button>
          <button className="btn-primary dub-skel-gen-btn" disabled>
            <Download size={11} /> MP4
          </button>
          <button className="btn-primary dub-skel-gen-btn" disabled>
            <Volume2 size={11} /> WAV
          </button>
          <button className="btn-primary dub-skel-gen-btn" disabled>
            <FileText size={11} /> SRT
          </button>
        </div>
      </div>
    </div>
  );
}
