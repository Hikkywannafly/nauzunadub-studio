import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { getTranslationSnapshot } from '../api/dub';
import './SubtitlePreview.css';

/**
 * SubtitlePreview — WYSIWYG preview cho burn-in subtitle.
 *
 * - Mount video element (dubbed preview track nếu có, fallback original)
 * - Overlay div positioned theo Alignment (top/middle/bottom) + MarginV (px)
 * - Font scale theo ratio cao video element so với 720p reference
 * - Active seg lấy từ currentTime → tìm seg.start ≤ t < seg.end
 * - Khi user truyền `snapshotId`, fetch full snapshot rows[] để lookup text
 *   theo lang khác (không cần restore snapshot vào current segments)
 *
 * Props match config knobs trong ExportModal — chỉ pure render, không lưu state.
 */
export default function SubtitlePreview({
  jobId, dubLangCode,
  snapshotId,
  position = 'bottom',
  marginV = 20,
  fontSize = 24,
  dual = false,
  bgColor = '',
  bgOpacity = 0,
  apiBase,
}) {
  const dubSegments = useAppStore((s) => s.dubSegments);
  const [snapshotRows, setSnapshotRows] = useState({}); // id → text
  const [currentTime, setCurrentTime] = useState(0);
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const [videoHeight, setVideoHeight] = useState(0);
  // Aspect ratio thật của video — match output ffmpeg. Default 16/9 trước khi
  // metadata load xong; sau onLoadedMetadata cập nhật từ videoWidth/videoHeight.
  const [aspectRatio, setAspectRatio] = useState('16 / 9');

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

  // Build active text from currentTime + active source (snapshot rows hoặc seg.text)
  const activeText = useMemo(() => {
    if (!dubSegments?.length) return '';
    const seg = dubSegments.find((s) => {
      const start = Number(s.start) || 0;
      const end = Number(s.end) || start;
      return currentTime >= start && currentTime < end;
    });
    if (!seg) return '';
    const translated = snapshotId
      ? (snapshotRows[String(seg.id)] || '').trim()
      : ((seg.text || '').trim());
    if (!dual) return translated || (seg.text_original || '').trim();
    const original = (seg.text_original || '').trim();
    if (!original || original === translated) return translated;
    return `${translated}\n${original}`; // CSS sẽ ý kiến italic line 2
  }, [dubSegments, currentTime, snapshotId, snapshotRows, dual]);

  // Measure video element height → scale font (font size in ASS is relative
  // to video resolution; assume 720p as ASS PlayResY default → 24pt ≈ 28px).
  useEffect(() => {
    if (!videoRef.current) return;
    const measure = () => {
      const h = videoRef.current?.clientHeight || 0;
      setVideoHeight(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(videoRef.current);
    return () => ro.disconnect();
  }, []);

  // ASS reference resolution = 720 (PlayResY). Scale = videoHeight / 720.
  // Round to avoid sub-px shimmer.
  const scale = videoHeight > 0 ? videoHeight / 720 : 1;
  const scaledFontPx = Math.max(8, Math.round(fontSize * scale));
  const scaledMarginPx = Math.max(0, Math.round(marginV * scale));

  // Positioning style — center horizontal, anchor vertically per ASS alignment
  const positionStyle = (() => {
    const base = {
      position: 'absolute',
      left: '50%',
      transform: 'translateX(-50%)',
      maxWidth: '90%',
      textAlign: 'center',
      pointerEvents: 'none',
    };
    if (position === 'top') return { ...base, top: scaledMarginPx };
    if (position === 'middle') return { ...base, top: '50%', transform: 'translate(-50%, -50%)' };
    return { ...base, bottom: scaledMarginPx };
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
    }
  };

  // BG color for the preview overlay — mirror what ffmpeg BorderStyle=3 produces.
  // bgOpacity > 0 → opaque box behind text, padding ngang/dọc. = 0 → text-shadow only.
  const subBgStyle = (bgOpacity > 0 && bgColor)
    ? {
        backgroundColor: hexWithAlpha(bgColor, bgOpacity / 100),
        padding: '4px 10px',
        borderRadius: '2px',
        textShadow: 'none', // CSS shadow + BG box trông xấu, ffmpeg BorderStyle=3 cũng skip outline
      }
    : {};

  return (
    <div className="sub-preview" ref={containerRef}>
      <div className="sub-preview__head">
        <span className="sub-preview__title">Preview</span>
        <span className="sub-preview__hint">
          Click play hoặc kéo timeline để xem sub ở các vị trí khác. Style match output ffmpeg.
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
            className="sub-preview__sub"
            style={{
              ...positionStyle,
              ...subBgStyle,
              fontSize: `${scaledFontPx}px`,
              lineHeight: 1.2,
            }}
          >
            {activeText.split('\n').map((line, i) => (
              <div key={i} className={i === 1 ? 'sub-preview__sub-line--orig' : 'sub-preview__sub-line'}>
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="sub-preview__meta">
        <span>{position} · margin {marginV}px · {fontSize}pt</span>
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

function hexWithAlpha(hex, alpha) {
  const s = (hex || '').replace('#', '');
  const norm = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (norm.length !== 6) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(norm.slice(0, 2), 16);
  const g = parseInt(norm.slice(2, 4), 16);
  const b = parseInt(norm.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
