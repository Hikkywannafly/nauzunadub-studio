import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useAppStore } from '../store';
import { getTranslationSnapshot } from '../api/dub';
import './SubtitlePreview.css';

/**
 * SubtitlePreview — WYSIWYG preview cho burn-in subtitle.
 *
 * - Mount video element (dubbed preview track nếu có, fallback original)
 * - Overlay div positioned theo Alignment (top/middle/bottom) + MarginV
 *   (px OR % of video height — pct ưu tiên khi > 0, portable across resolutions)
 * - Drag handle: kéo trực tiếp overlay → cập nhật vị trí theo % (callback
 *   `onMarginChange` để parent persist)
 * - Cue split: ngoài char-budget, còn force split khi avg duration/chunk
 *   > maxCueDuration → mirror backend `_split_segment_into_cues`
 *
 * Khi user truyền `snapshotId`, fetch full snapshot rows[] để lookup text
 * theo lang khác (không cần restore snapshot vào current segments).
 */
export default function SubtitlePreview({
  jobId, dubLangCode,
  snapshotId,
  position = 'bottom',
  marginV = 20,
  marginVPct = 0,           // 0 = dùng marginV px; > 0 = override theo %
  fontSize = 24,
  dual = false,
  bgColor = '',
  bgOpacity = 0,
  maxCharsPerLine = 32,
  maxLines = 2,
  maxCueDuration = 4.0,
  apiBase,
  onMarginChange,           // (pct, position) => void — drag persists qua parent
  draggable = true,
}) {
  const dubSegments = useAppStore((s) => s.dubSegments);
  const [snapshotRows, setSnapshotRows] = useState({});
  const [currentTime, setCurrentTime] = useState(0);
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const subRef = useRef(null);
  const [clientHeight, setClientHeight] = useState(0);
  const [videoNativeHeight, setVideoNativeHeight] = useState(720);
  const [aspectRatio, setAspectRatio] = useState('16 / 9');
  const [dragging, setDragging] = useState(false);

  // Fetch snapshot rows when picker changes — gives text in non-current lang.
  useEffect(() => {
    if (!jobId || !snapshotId) { setSnapshotRows({}); return; }
    let cancelled = false;
    (async () => {
      try {
        const snap = await getTranslationSnapshot(jobId, snapshotId);
        if (cancelled) return;
        const map = {};
        (snap.rows || []).forEach((r) => {
          if (r.error) return;
          const t = (r.text || '').trim();
          if (t) map[String(r.id)] = t;
        });
        setSnapshotRows(map);
      } catch {
        if (!cancelled) setSnapshotRows({});
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, snapshotId]);

  // Build cues using the same splitter as backend. Mirror logic in
  // `_split_segment_into_cues`: wrap → if avg dur > maxCueDuration, re-wrap
  // với maxLines=1 để sub flow theo nhịp đọc.
  const cues = useMemo(() => {
    if (!dubSegments?.length) return [];
    const out = [];
    for (const seg of dubSegments) {
      const start = Number(seg.start) || 0;
      const end = Number(seg.end) || start;
      const duration = Math.max(0.001, end - start);
      const translated = snapshotId
        ? (snapshotRows[String(seg.id)] || '').trim()
        : (seg.text || '').trim();
      const original = (seg.text_original || '').trim();
      const primary = translated || original;
      if (!primary) continue;

      let chunks = wrapForSubtitle(primary, maxCharsPerLine, maxLines);
      if (chunks.length === 0) continue;

      let effLines = maxLines;
      if (maxCueDuration > 0 && (duration / chunks.length) > maxCueDuration && maxLines > 1) {
        chunks = wrapForSubtitle(primary, maxCharsPerLine, 1);
        effLines = 1;
      }

      // Pre-wrap original 1 lần, dùng proportional index map khi count lệch.
      const origChunks = (dual && original && original !== translated)
        ? wrapForSubtitle(original, maxCharsPerLine, effLines)
        : [];

      const weights = chunks.map((c) => Math.max(1, c.replace(/\n/g, ' ').length));
      const totalW = weights.reduce((a, b) => a + b, 0);
      let cursor = start;
      const nChunks = chunks.length;
      chunks.forEach((chunk, i) => {
        const share = duration * (weights[i] / totalW);
        const cStart = cursor;
        const cEnd = i === nChunks - 1 ? end : Math.min(end, cursor + share);
        cursor = cEnd;
        let text = chunk;
        if (origChunks.length) {
          const oIdx = Math.min(origChunks.length - 1, Math.floor(i * origChunks.length / Math.max(1, nChunks)));
          text = `${chunk}\n${origChunks[oIdx]}`;
        }
        out.push({ start: cStart, end: cEnd, text });
      });
    }
    return out;
  }, [dubSegments, snapshotId, snapshotRows, dual, maxCharsPerLine, maxLines, maxCueDuration]);

  const activeText = useMemo(() => {
    const c = cues.find((x) => currentTime >= x.start && currentTime < x.end);
    return c ? c.text : '';
  }, [cues, currentTime]);

  useEffect(() => {
    if (!videoRef.current) return;
    const measure = () => {
      const h = videoRef.current?.clientHeight || 0;
      setClientHeight(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(videoRef.current);
    return () => ro.disconnect();
  }, []);

  // Resolve effective margin in px on the preview (client space).
  // Pct ưu tiên khi > 0 → consistent across resolutions. Fallback to px.
  const effectiveMarginPx = useMemo(() => {
    if (marginVPct > 0 && clientHeight > 0) {
      return Math.round((marginVPct / 100) * clientHeight);
    }
    const scale = videoNativeHeight > 0 && clientHeight > 0
      ? clientHeight / videoNativeHeight
      : 1;
    return Math.max(0, Math.round(marginV * scale));
  }, [marginVPct, marginV, clientHeight, videoNativeHeight]);

  const scale = videoNativeHeight > 0 && clientHeight > 0
    ? clientHeight / videoNativeHeight
    : 1;
  const scaledFontPx = Math.max(8, Math.round(fontSize * scale));

  const positionStyle = (() => {
    const base = {
      position: 'absolute',
      left: '50%',
      transform: 'translateX(-50%)',
      maxWidth: '90%',
      textAlign: 'center',
      pointerEvents: draggable ? 'auto' : 'none',
      cursor: draggable ? (dragging ? 'grabbing' : 'grab') : 'default',
      userSelect: 'none',
      touchAction: 'none',
    };
    if (position === 'top') return { ...base, top: effectiveMarginPx };
    if (position === 'middle') return { ...base, top: '50%', transform: 'translate(-50%, -50%)' };
    return { ...base, bottom: effectiveMarginPx };
  })();

  const videoSrc = jobId && apiBase
    ? `${apiBase}/dub/preview-video/${jobId}?lang=${encodeURIComponent(dubLangCode || '')}&preserve_bg=1`
    : null;

  const handleTimeUpdate = () => {
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime || 0);
  };

  const handleLoadedMetadata = () => {
    handleTimeUpdate();
    const v = videoRef.current;
    if (v && v.videoWidth && v.videoHeight) {
      setAspectRatio(`${v.videoWidth} / ${v.videoHeight}`);
      setVideoNativeHeight(v.videoHeight);
    }
  };

  // ── Drag handle ───────────────────────────────────────────────────────
  // Tính pct từ vị trí mouse Y relative tới container. Map về anchor edge:
  //   bottom → margin = (containerH - mouseY) / containerH * 100
  //   top    → margin = mouseY / containerH * 100
  //   middle → auto-promote tới top/bottom khi user kéo, vì middle là center fix
  const onPointerDown = useCallback((e) => {
    if (!draggable || !onMarginChange) return;
    if (position === 'middle') return; // middle = center fix, không drag
    e.preventDefault();
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [draggable, onMarginChange, position]);

  const onPointerMove = useCallback((e) => {
    if (!dragging || !containerRef.current) return;
    const stage = containerRef.current.querySelector('.sub-preview__stage');
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height;
    if (h <= 0) return;
    // Auto-pick anchor: nửa trên → top, nửa dưới → bottom
    const half = h / 2;
    const nextPos = y < half ? 'top' : 'bottom';
    const pct = nextPos === 'top'
      ? Math.max(0, Math.min(50, (y / h) * 100))
      : Math.max(0, Math.min(50, ((h - y) / h) * 100));
    onMarginChange?.(Number(pct.toFixed(1)), nextPos);
  }, [dragging, onMarginChange]);

  const onPointerUp = useCallback((e) => {
    if (!dragging) return;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, [dragging]);

  const subBgStyle = (bgOpacity > 0 && bgColor)
    ? {
        backgroundColor: hexWithAlpha(bgColor, bgOpacity / 100),
        padding: '4px 10px',
        borderRadius: '2px',
        textShadow: 'none',
      }
    : {};

  return (
    <div className="sub-preview" ref={containerRef}>
      <div className="sub-preview__head">
        <span className="sub-preview__title">Preview</span>
        <span className="sub-preview__hint">
          {draggable
            ? 'Kéo trực tiếp dòng sub để đổi vị trí · click play để check nhịp đọc.'
            : 'Click play hoặc kéo timeline để xem sub. Style match output ffmpeg.'}
        </span>
      </div>
      <div className="sub-preview__stage" style={{ aspectRatio }}>
        {videoSrc ? (
          <video
            ref={videoRef}
            src={videoSrc}
            controls
            className="sub-preview__video"
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            preload="metadata"
          />
        ) : (
          <div className="sub-preview__placeholder">
            Chưa có video để preview — generate dub trước
          </div>
        )}
        {activeText && (
          <div
            ref={subRef}
            className={`sub-preview__sub ${dragging ? 'is-dragging' : ''} ${draggable ? 'is-draggable' : ''}`}
            style={{
              ...positionStyle,
              ...subBgStyle,
              fontSize: `${scaledFontPx}px`,
              lineHeight: 1.2,
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            title={draggable && position !== 'middle' ? 'Kéo để đổi vị trí sub' : ''}
          >
            {activeText.split('\n').map((line, i) => (
              <div key={i} className={i === 1 ? 'sub-preview__sub-line--orig' : 'sub-preview__sub-line'}>
                {line}
              </div>
            ))}
          </div>
        )}
        {/* Guide line khi đang drag — visualize vị trí anchor */}
        {dragging && (
          <div className="sub-preview__guide" aria-hidden="true">
            <div className="sub-preview__guide-label">
              {position} · {marginVPct.toFixed(1)}%
            </div>
          </div>
        )}
      </div>
      <div className="sub-preview__meta">
        <span>
          {position} · margin {marginVPct > 0 ? `${marginVPct.toFixed(1)}%` : `${marginV}px`} · {fontSize}px
        </span>
        {bgOpacity > 0 && bgColor && (
          <span className="sub-preview__lang-badge" style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--chrome-fg)' }}>
            BG {bgColor} {bgOpacity}%
          </span>
        )}
        {snapshotId && <span className="sub-preview__lang-badge">snapshot</span>}
        {dual && <span className="sub-preview__lang-badge">dual</span>}
      </div>
    </div>
  );
}

// Mirror of backend `_wrap_text_for_subtitle`. Mọi thay đổi cần đồng bộ 2 phía
// để preview = output ffmpeg burn-in.
function wrapForSubtitle(text, maxCharsPerLine, maxLines) {
  const t = (text || '').trim();
  if (!t || maxCharsPerLine <= 0 || maxLines <= 0) return t ? [t] : [];
  const sentenceRe = /[^.!?。！？]+[.!?。！？]?/gu;
  const sentences = (t.match(sentenceRe) || [t]).map((s) => s.trim()).filter(Boolean);
  const lines = [];
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    let current = '';
    for (const w of words) {
      if (w.length > maxCharsPerLine) {
        if (current) { lines.push(current); current = ''; }
        lines.push(w);
        continue;
      }
      const candidate = current ? `${current} ${w}` : w;
      if (candidate.length <= maxCharsPerLine) current = candidate;
      else { lines.push(current); current = w; }
    }
    if (current) lines.push(current);
  }
  const chunks = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    chunks.push(lines.slice(i, i + maxLines).join('\n'));
  }
  return chunks.length ? chunks : [t];
}

function hexWithAlpha(hex, alpha) {
  const s = (hex || '').replace('#', '');
  const norm = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (norm.length !== 6) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(norm.slice(0, 2), 16);
  const g = parseInt(norm.slice(2, 4), 16);
  const b = parseInt(norm.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
