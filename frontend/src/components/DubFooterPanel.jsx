import React, { useState, useEffect } from 'react';
import { Loader, Square, Play, Download, Check, AlertCircle } from 'lucide-react';
import { useAppStore } from '../store';
import { Badge } from '../ui';
import { FooterBtn, fmtDur } from './DubTabHelpers';

export default function DubFooterPanel({
  incrementalPlan,
  handleDubGenerate,
  handleDubStop,
  onExportOpen,
}) {
  const dubStep      = useAppStore(s => s.dubStep);
  const dubProgress  = useAppStore(s => s.dubProgress);
  const dubSegments  = useAppStore(s => s.dubSegments);
  const dubError     = useAppStore(s => s.dubError);
  const dubTracks    = useAppStore(s => s.dubTracks);
  const dubLangCode  = useAppStore(s => s.dubLangCode);
  const preserveBg   = useAppStore(s => s.preserveBg);
  const setPreserveBg = useAppStore(s => s.setPreserveBg);
  const dualSubs     = useAppStore(s => s.dualSubs);
  const setDualSubs  = useAppStore(s => s.setDualSubs);
  const burnSubs     = useAppStore(s => s.burnSubs);
  const setBurnSubs  = useAppStore(s => s.setBurnSubs);
  const defaultTrack    = useAppStore(s => s.defaultTrack);
  const setDefaultTrack = useAppStore(s => s.setDefaultTrack);
  const exportTracks    = useAppStore(s => s.exportTracks);
  const setExportTracks = useAppStore(s => s.setExportTracks);

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

  return (
    <div className="studio-panel dub-footer-panel">
      {dubStep === 'done' && (
        <div className="dub-footer-banner">
          <Badge tone="success">
            <Check size={11} /> Done! Tracks: {dubTracks.join(', ')}
          </Badge>
          {incrementalPlan && incrementalPlan.stale?.length > 0 && (
            <Badge tone="warn" className="dub-footer-banner__badge-gap">
              {incrementalPlan.stale.length} segment{incrementalPlan.stale.length === 1 ? '' : 's'} changed since last generate
            </Badge>
          )}
          {incrementalPlan && incrementalPlan.stale?.length === 0 && incrementalPlan.fresh?.length > 0 && (
            <Badge tone="neutral" className="dub-footer-banner__badge-gap">
              all {incrementalPlan.fresh.length} segments up to date
            </Badge>
          )}
        </div>
      )}
      {dubError && (
        <div className="dub-footer-banner">
          <Badge tone="danger">
            <AlertCircle size={11} /> {dubError}
          </Badge>
        </div>
      )}

      <div className="dub-outputs-row">
        <span className="dub-outputs-title-strong">Output Options:</span>
        <label>
          <input type="checkbox" checked={preserveBg} onChange={e => setPreserveBg(e.target.checked)} /> Mix BG Audio
        </label>
        <label title="Export subtitles with translated text on top and original italicised underneath.">
          <input type="checkbox" checked={!!dualSubs} onChange={e => setDualSubs(e.target.checked)} /> Dual subtitles
        </label>
        <label title="Render subtitles directly into the MP4 video stream (hardsubs). Uses the dual-subtitle format when Dual subtitles is on.">
          <input type="checkbox" checked={!!burnSubs} onChange={e => setBurnSubs(e.target.checked)} /> Burn subtitles
        </label>
        <label>
          Default Track:
          <select className="input-base dub-outputs-default" value={defaultTrack} onChange={e => setDefaultTrack(e.target.value)}>
            <option value="original">Original</option>
            {dubLangCode && <option value={dubLangCode}>{dubLangCode} (Selected Dub)</option>}
            {dubTracks.filter(t => t !== dubLangCode).map(t => (
              <option key={t} value={t}>{t} (Dub)</option>
            ))}
          </select>
        </label>
      </div>

      {dubTracks.length > 0 && (
        <div className="dub-tracks-row">
          <span className="dub-tracks-row__title">Export Tracks:</span>
          <label className={exportTracks['original'] ? 'is-on' : 'is-off'}>
            <input type="checkbox" checked={exportTracks['original'] !== false} onChange={e => setExportTracks(prev => ({ ...prev, original: e.target.checked }))} />
            <span>Original</span>
          </label>
          {dubTracks.map(t => (
            <label key={t} className={exportTracks[t] !== false ? 'is-on is-success' : 'is-off'}>
              <input type="checkbox" checked={exportTracks[t] !== false} onChange={e => setExportTracks(prev => ({ ...prev, [t]: e.target.checked }))} />
              <span className="code">{t}</span>
            </label>
          ))}
        </div>
      )}

      <div className="dub-footer-btns">
        {dubStep === 'stopping' ? (
          <FooterBtn tone="stopping" disabled icon={<Loader className="spinner" size={9} />} label="Stopping…" />
        ) : dubStep === 'generating' ? (
          <FooterBtn
            tone="danger"
            onClick={handleDubStop}
            icon={<Square size={9} />}
            label={`Stop (${dubProgress.current}/${dubProgress.total})`}
          />
        ) : (
          <>
            <FooterBtn
              tone="idle"
              onClick={() => handleDubGenerate()}
              disabled={!dubSegments.length}
              icon={<Play size={11} />}
              label="Generate Dub"
            />
            {dubStep === 'done' && incrementalPlan && incrementalPlan.stale?.length > 0 && (
              <FooterBtn
                tone="pink"
                onClick={() => handleDubGenerate({ regenOnly: incrementalPlan.stale, preview: true })}
                icon={<Play size={11} />}
                label={`Regen ${incrementalPlan.stale.length} changed`}
              />
            )}
          </>
        )}
        <FooterBtn
          tone={dubStep === 'done' ? 'green' : 'idle'}
          disabled={dubStep !== 'done' && !dubSegments.length}
          onClick={onExportOpen}
          icon={<Download size={11} />}
          label="Export…"
        />
      </div>
    </div>
  );
}
