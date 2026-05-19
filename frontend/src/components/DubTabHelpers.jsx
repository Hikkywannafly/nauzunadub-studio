import React from 'react';
import { Loader, Square } from 'lucide-react';
import { Button, Progress } from '../ui';

export function fmtDur(s) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return sec ? `${m}m ${sec}s` : `${m}m`;
}

const PREP_STAGE_LABEL = {
  download: 'Downloading video…',
  extract:  'Extracting audio…',
  demucs:   'Separating vocals / music (Demucs)…',
  scene:    'Detecting scene cuts…',
  cached:   '⚡ Using cached results…',
};
const PREP_FULL   = ['download', 'extract', 'demucs', 'scene'];
const PREP_CACHED = ['download', 'extract', 'cached'];

export function PrepOverlay({ stage, onAbort, large = false }) {
  const stages = stage === 'cached' ? PREP_CACHED : PREP_FULL;
  const body = (
    <>
      <Loader className="spinner" size={large ? 28 : 20} color="#d3869b" />
      <span className="dub-prep-overlay__title" style={{ fontSize: large ? '0.95rem' : '0.85rem' }}>
        {PREP_STAGE_LABEL[stage] || 'Preparing…'}
      </span>
      <div className={`dub-prep-chips ${large ? 'dub-prep-chips--lg' : ''}`}>
        {stages.map(s => (
          <span
            key={s}
            className={`dub-prep-chip ${stage === s ? 'is-active' : ''} ${s === 'cached' ? 'is-cached' : ''}`}
          >
            {s === 'cached' ? '⚡ cached' : s}
          </span>
        ))}
      </div>
      {stage === 'demucs' && (
        <span className="dub-prep-overlay__note">
          Demucs can take several minutes on long videos. Long audio = longer wait.
        </span>
      )}
      <Button variant="danger" size="sm" onClick={onAbort} leading={<Square size={11} />}>
        Stop
      </Button>
    </>
  );
  return large
    ? <div className="dub-prep-overlay dub-prep-overlay--large">{body}</div>
    : <div className="dub-prep-overlay">{body}</div>;
}

export function TranscribeOverlay({ elapsed, duration, onAbort }) {
  const est = duration > 0 ? Math.max(10, Math.ceil(duration / 60) * 3 + 8) : 0;
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, '0');
  return (
    <div className="dub-trans-overlay">
      <div className="dub-trans-overlay__head">
        <Loader className="spinner" size={18} color="#d3869b" />
        <span className="dub-trans-overlay__title">Transcribing with Whisper…</span>
      </div>
      <div className="dub-trans-overlay__stats">
        <span>⏱ {mm}:{ss} elapsed</span>
        {est > 0 && <span>~{Math.max(0, est - elapsed)}s remaining</span>}
      </div>
      {duration > 0 && (
        <div className="dub-trans-overlay__bar">
          <Progress value={Math.min(95, (elapsed / est) * 100)} tone="brand" size="sm" />
        </div>
      )}
      <Button variant="danger" size="sm" onClick={onAbort} leading={<Square size={11} />}>
        Stop
      </Button>
    </div>
  );
}

export const FooterBtn = React.forwardRef(function FooterBtn(
  { tone = 'idle', sm = false, disabled, onClick, icon, label, ...rest },
  ref,
) {
  const cls = [
    'btn-primary',
    'dub-footer-btn',
    sm && 'dub-footer-btn--sm',
    `dub-footer-btn--${tone}`,
  ].filter(Boolean).join(' ');
  return (
    <button ref={ref} className={cls} disabled={disabled} onClick={onClick} {...rest}>
      {icon} {label}
    </button>
  );
});
