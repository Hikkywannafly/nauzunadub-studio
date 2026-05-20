import React, { useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Film, Volume2, FileText, Package, Music, Layers, Download,
  Check, Globe, Zap, X, Building2,
} from 'lucide-react';
import { Button, Segmented, Badge } from '../ui';
import { listTranslationSnapshots, uploadCustomBg, getCustomBgInfo, deleteCustomBg } from '../api/dub';
import SubtitlePreview from './SubtitlePreview';
import './ExportModal.css';

/**
 * ExportModal — comprehensive export panel for the dubbing studio.
 *
 * Tabs: Video · Audio · Subtitles · Package. Each tab owns a small bundle of
 * format/track/quality controls. The shared track list at the top lets the
 * user pick which languages participate in whatever tab they land on — so
 * "export all dubs as SRT" and "mux these 3 tracks into the MP4" share one
 * source of truth instead of living as three separate dropdowns.
 */
const PRESETS = {
  youtube:  { label: 'YouTube',  tab: 'video', format: 'mp4', preserveBg: true,  burnSubs: false, defaultTrack: 'dub' },
  archive:  { label: 'Archive',  tab: 'video', format: 'mp4', preserveBg: true,  burnSubs: false, includeAll: true },
  web:      { label: 'Web',      tab: 'video', format: 'mp4', preserveBg: true,  burnSubs: true,  dualSubs: false },
  podcast:  { label: 'Podcast',  tab: 'audio', audioFormat: 'mp3', mp3Bitrate: '192', preserveBg: false },
  studyset: { label: 'Study set',tab: 'subs',  subsFormat: 'srt', subsDual: true },
};

export default function ExportModal({
  open, onClose,
  jobId, filename, dubTracks, dubLangCode,
  preserveBg, setPreserveBg,
  defaultTrack, setDefaultTrack,
  exportTracks, setExportTracks,
  dualSubs, setDualSubs,
  burnSubs, setBurnSubs,
  API,
  triggerDownload,
  handleDubDownload, handleDubAudioDownload, handleAudioExport,
  segmentCount = 0,
  onEnterprise,
}) {
  const [tab, setTab] = useState('video');

  // ── Tab-local state (not persisted across sessions — each open is fresh).
  const [videoFormat, setVideoFormat] = useState('mp4');   // future: webm/mov
  const [audioFormat, setAudioFormat] = useState('wav');   // wav | mp3
  const [mp3Bitrate, setMp3Bitrate] = useState('192');     // 128/192/256/320
  const [audioBatch, setAudioBatch] = useState('each');    // each | primary — per-lang or single file
  const [audioPrimaryLang, setAudioPrimaryLang] = useState(dubLangCode || '');
  const [subsFormat, setSubsFormat] = useState('srt');     // srt | vtt | both
  const [subsDual, setSubsDual] = useState(!!dualSubs);
  const [subsBatch, setSubsBatch] = useState('target');    // target | all-dubs | snapshot
  // Translation snapshots — cho phép user xuất sub theo bất kỳ bản dịch nào
  // đã làm trong cùng video. Khi rỗng → ẩn picker, fall về 'target' / 'all-dubs'.
  const [translationSnapshots, setTranslationSnapshots] = useState([]);
  const [subsSnapshotId, setSubsSnapshotId] = useState('');
  // Burn-in position config (chỉ dùng khi burnSubs=true)
  const [subPosition, setSubPosition] = useState('bottom'); // bottom | middle | top
  // Margin: hai mode. Pct (% video height) là default — portable cross-resolution.
  // Px giữ lại cho user nào quen với absolute, toggle qua subMarginMode.
  const [subMarginMode, setSubMarginMode] = useState('pct'); // 'pct' | 'px'
  const [subMarginVPct, setSubMarginVPct] = useState(8); // % of video height
  const [subMarginV, setSubMarginV] = useState(20);
  const [subFontSize, setSubFontSize] = useState(24);
  // Subtitle background box (ASS BorderStyle=3) — off khi opacity=0
  const [subBgColor, setSubBgColor] = useState('#000000');
  const [subBgOpacity, setSubBgOpacity] = useState(0); // 0 = no BG box
  // Subtitle line wrapping: segs dài chia thành nhiều cue ≤ N ký tự × M dòng.
  // 32×2 phù hợp Reels/Shorts; tăng lên 42 cho 16:9 truyền thống.
  const [subMaxChars, setSubMaxChars] = useState(32);
  const [subMaxLines, setSubMaxLines] = useState(2);
  // Max giây / cue → buộc split khi sub đứng yên quá lâu so với nhịp đọc
  const [subMaxCueDuration, setSubMaxCueDuration] = useState(4);
  // Background audio config
  const [bgSource, setBgSource] = useState('original'); // original | custom | off
  const [bgVolume, setBgVolume] = useState(80);         // 0-200 %, divided by 100 trên URL
  const [customBgInfo, setCustomBgInfo] = useState({ exists: false });
  const [uploadingBg, setUploadingBg] = useState(false);

  // Reflect the parent's dual/burn once, then own them locally so the modal
  // can toy with them without committing on cancel.
  useEffect(() => { setSubsDual(!!dualSubs); }, [open, dualSubs]);

  // Load translation snapshots when modal opens — used để picker dropdown
  // chọn ngôn ngữ sub. Lỗi 404 trên job mới chưa translate là bình thường.
  useEffect(() => {
    if (!open || !jobId) return;
    (async () => {
      try {
        const res = await listTranslationSnapshots(jobId);
        setTranslationSnapshots(res.snapshots || []);
      } catch {
        setTranslationSnapshots([]);
      }
      try {
        const info = await getCustomBgInfo(jobId);
        setCustomBgInfo(info);
      } catch {
        setCustomBgInfo({ exists: false });
      }
    })();
  }, [open, jobId]);

  const handleBgUpload = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file || !jobId) return;
      setUploadingBg(true);
      try {
        const res = await uploadCustomBg(jobId, file);
        setCustomBgInfo({ exists: true, filename: res.filename, size_bytes: res.size_bytes });
        setBgSource('custom');
      } catch (err) {
        alert(`Upload nhạc nền thất bại: ${err.message || err}`);
      } finally {
        setUploadingBg(false);
      }
    };
    input.click();
  };

  const handleBgDelete = async () => {
    if (!jobId || !customBgInfo.exists) return;
    try {
      await deleteCustomBg(jobId);
      setCustomBgInfo({ exists: false });
      if (bgSource === 'custom') setBgSource('original');
    } catch (err) {
      alert(`Xoá nhạc nền thất bại: ${err.message || err}`);
    }
  };

  // ── Drawer dismiss — ESC closes; click-outside closes. The drawer is a
  // bottom sheet (non-blocking), so background interactions stay live.
  const drawerRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    const onDown = (e) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target)) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, onClose]);

  const allTracks = useMemo(() => {
    const out = [{ code: 'original', label: 'Original', kind: 'original' }];
    (dubTracks || []).forEach(t => out.push({ code: t, label: t.toUpperCase(), kind: 'dub' }));
    return out;
  }, [dubTracks]);

  const dubOnlyTracks = useMemo(() => allTracks.filter(t => t.kind === 'dub'), [allTracks]);
  const selectedTracks = allTracks.filter(t => exportTracks[t.code] !== false);
  const selectedDubs = selectedTracks.filter(t => t.kind === 'dub');

  const toggleTrack = (code) => setExportTracks(prev => ({ ...prev, [code]: prev[code] === false ? true : false }));
  const setAllTracks = (on) => setExportTracks(Object.fromEntries(allTracks.map(t => [t.code, on])));
  const setDubsOnly  = () => setExportTracks(Object.fromEntries(allTracks.map(t => [t.code, t.kind === 'dub'])));

  // ── Presets — map label → state deltas and jump to the right tab.
  const applyPreset = (key) => {
    const p = PRESETS[key];
    if (!p) return;
    setTab(p.tab);
    if (p.preserveBg !== undefined) setPreserveBg(!!p.preserveBg);
    if (p.burnSubs   !== undefined) setBurnSubs(!!p.burnSubs);
    if (p.dualSubs   !== undefined) setSubsDual(!!p.dualSubs);
    if (p.audioFormat) setAudioFormat(p.audioFormat);
    if (p.mp3Bitrate)  setMp3Bitrate(p.mp3Bitrate);
    if (p.subsFormat)  setSubsFormat(p.subsFormat);
    if (p.subsDual !== undefined) setSubsDual(!!p.subsDual);
    if (p.includeAll)  setAllTracks(true);
    if (p.defaultTrack === 'dub' && dubLangCode) setDefaultTrack(dubLangCode);
  };

  // ── Filename preview — purely cosmetic, mirrors how the server names files.
  const baseName = useMemo(() => {
    const raw = (filename || 'output').replace(/\.[^.]+$/, '');
    return raw.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'output';
  }, [filename]);

  const filenamePreview = (() => {
    if (tab === 'video') return `dubbed_${baseName}_…mp4`;
    if (tab === 'audio') {
      const ext = audioFormat;
      if (audioBatch === 'each') return `dubbed_<lang>_${baseName}_…${ext}  (${selectedDubs.length} files)`;
      return `dubbed_${audioPrimaryLang || dubLangCode}_${baseName}_…${ext}`;
    }
    if (tab === 'subs') {
      const langs = subsBatch === 'all-dubs' ? selectedDubs.length || 1 : 1;
      const exts = subsFormat === 'both' ? 'srt+vtt' : subsFormat;
      return `subtitles${subsDual ? '_dual' : ''}.${exts}  (${langs} file${langs === 1 ? '' : 's'})`;
    }
    return 'archive.zip';
  })();

  // ── Validity: what's runnable right now?
  const canVideo = selectedTracks.length > 0 && (dubTracks || []).length > 0;
  const canAudio = audioBatch === 'each'
    ? selectedDubs.length > 0
    : !!audioPrimaryLang && (dubTracks || []).includes(audioPrimaryLang);
  const canSubs  = segmentCount > 0 && (subsBatch !== 'all-dubs' || selectedDubs.length > 0);

  // ── Runners — fire backend calls based on tab. Each returns quickly;
  // toasts inside triggerDownload keep the user informed.
  const runVideo = () => {
    const opts = {
      bg_source: bgSource,
      bg_volume: bgVolume / 100,
    };
    if (burnSubs) {
      if (subsSnapshotId) opts.sub_snapshot_id = subsSnapshotId;
      opts.sub_position = subPosition;
      if (subMarginMode === 'pct') {
        opts.sub_margin_v_pct = subMarginVPct;
      } else {
        opts.sub_margin_v = subMarginV;
      }
      opts.sub_font_size = subFontSize;
      if (subBgOpacity > 0) {
        opts.sub_bg_color = subBgColor;
        opts.sub_bg_opacity = subBgOpacity;
      }
      opts.sub_max_chars_per_line = subMaxChars;
      opts.sub_max_lines = subMaxLines;
      opts.sub_max_cue_duration = subMaxCueDuration;
    }
    handleDubDownload?.(opts);
    onClose?.();
  };
  const runAudio = () => {
    const langs = audioBatch === 'each'
      ? selectedDubs.map(t => t.code)
      : [audioPrimaryLang || dubLangCode];
    langs.forEach(lang => {
      if (!lang) return;
      const params = new URLSearchParams({
        lang,
        bg_source: bgSource,
        bg_volume: String(bgVolume / 100),
        // Legacy preserve_bg vẫn truyền để backend cũ vẫn chạy được nếu rollback.
        preserve_bg: bgSource === 'off' ? '0' : '1',
      });
      const q = params.toString();
      if (audioFormat === 'wav') {
        const url = `${API}/dub/download-audio/${jobId}/dubbed_${lang}.wav?${q}`;
        handleAudioExport?.(url, `dubbed_${lang}.wav`);
      } else {
        const url = `${API}/dub/download-mp3/${jobId}/dubbed_${lang}.mp3?${q}&bitrate=${mp3Bitrate}k`;
        handleAudioExport?.(url, `dubbed_${lang}.mp3`);
      }
    });
    onClose?.();
  };
  const runSubs = () => {
    // `snapshot` mode: 1 file lấy text từ snapshot đã chọn (ngôn ngữ cụ thể)
    // `all-dubs` : 1 file cho mỗi snapshot/track được chọn — nhưng hiện tại
    //              backend chỉ render từ 1 snapshot/lần, nên fallback về snapshots
    // `target` : 1 file từ current segments (legacy)
    const formats = subsFormat === 'both' ? ['srt', 'vtt'] : [subsFormat];
    const exportOne = (lang, snapId) => {
      formats.forEach((ext) => {
        const name = `subtitles${subsDual ? '_dual' : ''}_${lang}.${ext}`;
        const q = new URLSearchParams({
          dual: subsDual ? '1' : '0',
          max_chars_per_line: String(subMaxChars),
          max_lines: String(subMaxLines),
          max_cue_duration: String(subMaxCueDuration),
        });
        if (snapId) q.set('snapshot_id', snapId);
        const url = `${API}/dub/${ext}/${jobId}/${name}?${q.toString()}`;
        triggerDownload?.(url, name);
      });
    };

    if (subsBatch === 'snapshot' && subsSnapshotId) {
      const snap = translationSnapshots.find((s) => s.id === subsSnapshotId);
      const lang = snap?.target_lang || dubLangCode || 'sub';
      exportOne(lang, subsSnapshotId);
    } else if (subsBatch === 'all-dubs') {
      // Mỗi target_lang trong snapshots → 1 file. Nếu chưa có snapshot dùng track codes.
      if (translationSnapshots.length > 0) {
        // Pick the newest snapshot per language
        const byLang = new Map();
        for (const s of translationSnapshots) {
          if (!byLang.has(s.target_lang)) byLang.set(s.target_lang, s);
        }
        byLang.forEach((s, lang) => exportOne(lang, s.id));
      } else {
        selectedDubs.forEach((t) => exportOne(t.code, undefined));
      }
    } else {
      exportOne(dubLangCode, undefined);
    }
    onClose?.();
  };
  const runStems = () => {
    handleAudioExport?.(`${API}/dub/export-stems/${jobId}`, 'stems.zip');
    onClose?.();
  };
  const runClips = () => {
    handleAudioExport?.(`${API}/dub/export-segments/${jobId}`, 'segments.zip');
    onClose?.();
  };

  const runMap = {
    video: { fn: runVideo, can: canVideo, label: 'Export MP4' },
    audio: { fn: runAudio, can: canAudio, label: audioBatch === 'each' ? `Export ${selectedDubs.length} audio file${selectedDubs.length === 1 ? '' : 's'}` : 'Export audio' },
    subs:  { fn: runSubs,  can: canSubs,  label: 'Export subtitles' },
    pkg:   { fn: null,     can: false,    label: 'Export' },
  };
  const active = runMap[tab];

  if (!open) return null;

  return createPortal(
    <div className="export-drawer" role="dialog" aria-modal="false" aria-label="Export options">
      <div className="export-drawer__sheet" ref={drawerRef}>
        <header className="export-drawer__head">
          <span className="export-drawer__handle" aria-hidden="true" />
          <span className="export-modal__title-inner">
            <Download size={13} /> Export
            {filename && <span className="export-modal__filename">· {filename}</span>}
          </span>
          <button type="button" className="export-drawer__close" onClick={onClose} aria-label="Close export drawer">
            <X size={13} />
          </button>
        </header>
        <div className="export-modal export-modal--drawer">
        {/* Preset chips */}
        <div className="export-modal__presets">
          <span className="export-modal__kicker">PRESETS</span>
          {Object.entries(PRESETS).map(([k, v]) => (
            <button key={k} type="button" className="export-modal__preset-chip" onClick={() => applyPreset(k)} title={`Jump to ${v.tab} tab with ${v.label} defaults`}>
              <Zap size={9} /> {v.label}
            </button>
          ))}
        </div>

        {/* Track checklist — shared across tabs */}
        <div className="export-modal__tracks">
          <div className="export-modal__section-head">
            <span className="export-modal__kicker"><Globe size={9} /> TRACKS</span>
            <div className="export-modal__track-quick">
              <button type="button" onClick={() => setAllTracks(true)}>All</button>
              <span>·</span>
              <button type="button" onClick={() => setAllTracks(false)}>None</button>
              <span>·</span>
              <button type="button" onClick={setDubsOnly}>Dubs only</button>
            </div>
          </div>
          <div className="export-modal__track-row">
            {allTracks.map(t => {
              const on = exportTracks[t.code] !== false;
              return (
                <label key={t.code} className={`export-modal__track ${on ? 'is-on' : ''} ${t.kind === 'original' ? 'is-original' : 'is-dub'}`}>
                  <input type="checkbox" checked={on} onChange={() => toggleTrack(t.code)} />
                  <span className="export-modal__track-label">{t.label}</span>
                  {t.kind === 'dub' && t.code === dubLangCode && <Badge tone="brand" size="xs">primary</Badge>}
                </label>
              );
            })}
          </div>
        </div>

        {/* Tabs */}
        <div className="export-modal__tabs">
          <button type="button" className={`export-modal__tab ${tab === 'video' ? 'is-active' : ''}`} onClick={() => setTab('video')}>
            <Film size={10} /> Video
          </button>
          <button type="button" className={`export-modal__tab ${tab === 'audio' ? 'is-active' : ''}`} onClick={() => setTab('audio')}>
            <Volume2 size={10} /> Audio
          </button>
          <button type="button" className={`export-modal__tab ${tab === 'subs' ? 'is-active' : ''}`} onClick={() => setTab('subs')}>
            <FileText size={10} /> Subtitles
          </button>
          <button type="button" className={`export-modal__tab ${tab === 'pkg' ? 'is-active' : ''}`} onClick={() => setTab('pkg')}>
            <Package size={10} /> Package
          </button>
        </div>

        {/* Tab body */}
        <div className="export-modal__body">
          {tab === 'video' && (
            <div className="export-modal__grid">
              <Field label="Container">
                <Segmented size="sm" value={videoFormat} onChange={setVideoFormat} items={[
                  { value: 'mp4', label: 'MP4 (H.264)' },
                ]} />
              </Field>
              <Field label="Default audio track" hint="Which audio stream plays by default when the viewer opens the file">
                <select className="input-base input-base--xs" value={defaultTrack} onChange={e => setDefaultTrack(e.target.value)}>
                  {exportTracks['original'] !== false && <option value="original">Original</option>}
                  {(dubTracks || []).filter(t => exportTracks[t] !== false).map(t => (
                    <option key={t} value={t}>{t.toUpperCase()} (Dub)</option>
                  ))}
                </select>
              </Field>
              <Field label="Background audio">
                <BgControls
                  bgSource={bgSource}
                  setBgSource={(v) => {
                    setBgSource(v);
                    setPreserveBg(v !== 'off');
                  }}
                  bgVolume={bgVolume}
                  setBgVolume={setBgVolume}
                  customBgInfo={customBgInfo}
                  uploadingBg={uploadingBg}
                  onUpload={handleBgUpload}
                  onDelete={handleBgDelete}
                />
              </Field>
              <Field
                label="Subtitles in video"
                className={burnSubs ? 'export-modal__field--wide' : ''}
              >
                <label className="export-modal__toggle">
                  <input type="checkbox" checked={burnSubs} onChange={e => setBurnSubs(e.target.checked)} />
                  Burn subtitles into picture (hardsub)
                </label>
                {burnSubs && (
                  <div className="export-modal__sub-layout">
                    <div className="export-modal__sub-controls">
                      <label className="export-modal__toggle">
                        <input type="checkbox" checked={!!dualSubs} onChange={e => setDualSubs(e.target.checked)} />
                        Dual (translated on top of italicised original)
                      </label>

                      {translationSnapshots.length > 0 && (
                        <SubGroup title="Source">
                          <SubRow label="Language">
                            <select
                              className="input-base input-base--xs"
                              value={subsSnapshotId}
                              onChange={(e) => setSubsSnapshotId(e.target.value)}
                              style={{ flex: 1 }}
                            >
                              <option value="">Current ({dubLangCode || '—'})</option>
                              {translationSnapshots.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {(s.target_lang || '?').toUpperCase()} · {s.provider || '—'} · {s.quality || 'fast'}
                                </option>
                              ))}
                            </select>
                          </SubRow>
                        </SubGroup>
                      )}

                      <SubGroup title="Position">
                        <SubRow label="Anchor">
                          <Segmented
                            size="sm"
                            value={subPosition}
                            onChange={setSubPosition}
                            items={[
                              { value: 'bottom', label: 'Bottom' },
                              { value: 'middle', label: 'Middle' },
                              { value: 'top', label: 'Top' },
                            ]}
                          />
                        </SubRow>
                        <SubRow label="Unit">
                          <Segmented
                            size="sm"
                            value={subMarginMode}
                            onChange={setSubMarginMode}
                            items={[
                              { value: 'pct', label: '% of video' },
                              { value: 'px', label: 'Pixels' },
                            ]}
                          />
                        </SubRow>
                        {subMarginMode === 'pct' ? (
                          <SubRow label={<>Margin <code>{subMarginVPct.toFixed(1)}%</code></>}>
                            <input
                              type="range" min="0" max="50" step="0.5"
                              value={subMarginVPct}
                              onChange={(e) => setSubMarginVPct(Number(e.target.value))}
                              className="export-modal__slider"
                            />
                          </SubRow>
                        ) : (
                          <SubRow label={<>Margin <code>{subMarginV}px</code></>}>
                            <input
                              type="range" min="0" max="500" step="5"
                              value={subMarginV}
                              onChange={(e) => setSubMarginV(Number(e.target.value))}
                              className="export-modal__slider"
                            />
                          </SubRow>
                        )}
                        <div className="export-modal__sub-hint">
                          Kéo trực tiếp dòng sub trong preview để chỉnh đúng vị trí muốn che sub gốc.
                        </div>
                      </SubGroup>

                      <SubGroup title="Typography">
                        <SubRow label={<>Font size <code>{subFontSize}px</code></>}>
                          <input
                            type="range" min="12" max="120" step="2"
                            value={subFontSize}
                            onChange={(e) => setSubFontSize(Number(e.target.value))}
                            className="export-modal__slider"
                          />
                        </SubRow>
                        <div className="export-modal__sub-hint">
                          Px là chiều cao thực trên video gốc. Video 1080×1920 thử 48-72px, 1920×1080 thử 28-40px.
                        </div>
                      </SubGroup>

                      <SubGroup title="Background box">
                        <SubRow label="Color">
                          <input
                            type="color"
                            value={subBgColor}
                            onChange={(e) => setSubBgColor(e.target.value)}
                            className="export-modal__color"
                          />
                          <code className="export-modal__mono-dim">{subBgColor}</code>
                        </SubRow>
                        <SubRow label={<>Opacity <code>{subBgOpacity}%</code></>}>
                          <input
                            type="range" min="0" max="100" step="5"
                            value={subBgOpacity}
                            onChange={(e) => setSubBgOpacity(Number(e.target.value))}
                            className="export-modal__slider"
                          />
                          {subBgOpacity > 0 && (
                            <button
                              type="button"
                              className="export-modal__off-btn"
                              onClick={() => setSubBgOpacity(0)}
                              title="Tắt BG box (về outline-only)"
                            >Off</button>
                          )}
                        </SubRow>
                      </SubGroup>

                      <SubGroup title="Timing & wrap">
                        <SubRow label={<>Max cue <code>{subMaxCueDuration}s</code></>}>
                          <input
                            type="range" min="1.5" max="8" step="0.5"
                            value={subMaxCueDuration}
                            onChange={(e) => setSubMaxCueDuration(Number(e.target.value))}
                            className="export-modal__slider"
                          />
                        </SubRow>
                        <SubRow label={<>Chars / line <code>{subMaxChars}</code></>}>
                          <input
                            type="range" min="20" max="60" step="1"
                            value={subMaxChars}
                            onChange={(e) => setSubMaxChars(Number(e.target.value))}
                            className="export-modal__slider"
                          />
                        </SubRow>
                        <SubRow label={<>Lines <code>{subMaxLines}</code></>}>
                          <input
                            type="range" min="1" max="3" step="1"
                            value={subMaxLines}
                            onChange={(e) => setSubMaxLines(Number(e.target.value))}
                            className="export-modal__slider"
                          />
                        </SubRow>
                        <div className="export-modal__sub-hint">
                          Giảm <code>max cue</code> nếu sub đứng yên lâu hơn nhịp đọc. 32 ký tự / dòng phù hợp Reels/Shorts.
                        </div>
                      </SubGroup>
                    </div>
                    <div className="export-modal__sub-preview-wrap">
                      <SubtitlePreview
                        jobId={jobId}
                        dubLangCode={dubLangCode}
                        snapshotId={subsSnapshotId || undefined}
                        position={subPosition}
                        marginV={subMarginV}
                        marginVPct={subMarginMode === 'pct' ? subMarginVPct : 0}
                        fontSize={subFontSize}
                        dual={subsDual}
                        bgColor={subBgColor}
                        bgOpacity={subBgOpacity}
                        maxCharsPerLine={subMaxChars}
                        maxLines={subMaxLines}
                        maxCueDuration={subMaxCueDuration}
                        apiBase={API}
                        draggable={subMarginMode === 'pct'}
                        onMarginChange={(pct, nextPos) => {
                          setSubMarginMode('pct');
                          setSubMarginVPct(pct);
                          if (nextPos && nextPos !== subPosition) setSubPosition(nextPos);
                        }}
                      />
                    </div>
                  </div>
                )}
              </Field>
            </div>
          )}

          {tab === 'audio' && (
            <div className="export-modal__grid">
              <Field label="Format">
                <Segmented size="sm" value={audioFormat} onChange={setAudioFormat} items={[
                  { value: 'wav', label: 'WAV (lossless)' },
                  { value: 'mp3', label: 'MP3 (compressed)' },
                ]} />
              </Field>
              {audioFormat === 'mp3' && (
                <Field label="Bitrate">
                  <Segmented size="sm" value={mp3Bitrate} onChange={setMp3Bitrate} items={[
                    { value: '128', label: '128k' },
                    { value: '192', label: '192k' },
                    { value: '256', label: '256k' },
                    { value: '320', label: '320k' },
                  ]} />
                </Field>
              )}
              <Field label="What to export">
                <Segmented size="sm" value={audioBatch} onChange={setAudioBatch} items={[
                  { value: 'each',    label: 'Every selected dub (separate files)' },
                  { value: 'primary', label: 'Single language' },
                ]} />
                {audioBatch === 'primary' && (
                  <select className="input-base input-base--xs export-modal__mt6"
                    value={audioPrimaryLang} onChange={e => setAudioPrimaryLang(e.target.value)}>
                    {(dubTracks || []).map(t => <option key={t} value={t}>{t.toUpperCase()}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Background audio">
                <BgControls
                  bgSource={bgSource}
                  setBgSource={(v) => {
                    setBgSource(v);
                    setPreserveBg(v !== 'off');
                  }}
                  bgVolume={bgVolume}
                  setBgVolume={setBgVolume}
                  customBgInfo={customBgInfo}
                  uploadingBg={uploadingBg}
                  onUpload={handleBgUpload}
                  onDelete={handleBgDelete}
                />
              </Field>
            </div>
          )}

          {tab === 'subs' && (
            <div className="export-modal__grid">
              <Field label="Format">
                <Segmented size="sm" value={subsFormat} onChange={setSubsFormat} items={[
                  { value: 'srt',  label: 'SRT' },
                  { value: 'vtt',  label: 'VTT' },
                  { value: 'both', label: 'Both' },
                ]} />
              </Field>
              <Field label="Layout">
                <Segmented size="sm" value={subsDual ? 'dual' : 'single'} onChange={v => setSubsDual(v === 'dual')} items={[
                  { value: 'single', label: 'Single line' },
                  { value: 'dual',   label: 'Dual (translated + original)' },
                ]} />
              </Field>
              <Field label="Languages">
                <Segmented size="sm" value={subsBatch} onChange={setSubsBatch} items={[
                  { value: 'target',   label: `Current (${dubLangCode || '—'})` },
                  ...(translationSnapshots.length > 0
                    ? [{ value: 'snapshot', label: 'Translation snapshot' }]
                    : []),
                  { value: 'all-dubs', label: `All (${translationSnapshots.length > 0 ? new Set(translationSnapshots.map(s => s.target_lang)).size : selectedDubs.length})` },
                ]} />
                {subsBatch === 'snapshot' && (
                  <select
                    className="input-base input-base--xs export-modal__mt6"
                    value={subsSnapshotId}
                    onChange={(e) => setSubsSnapshotId(e.target.value)}
                  >
                    <option value="">— Chọn bản dịch —</option>
                    {translationSnapshots.map((s) => (
                      <option key={s.id} value={s.id}>
                        {(s.target_lang || '?').toUpperCase()} · {s.provider || '—'} · {s.quality || 'fast'}
                        {s.genre ? ` · ${s.genre}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <div className="export-modal__note">
                {translationSnapshots.length > 0
                  ? `${translationSnapshots.length} bản dịch lưu cho video này. Chọn "Translation snapshot" rồi pick ngôn ngữ cụ thể.`
                  : 'Chưa có translation snapshot nào — sub sẽ lấy text từ segments hiện tại. Translate trước để có nhiều bản chọn.'}
              </div>
              <SubtitlePreview
                jobId={jobId}
                dubLangCode={dubLangCode}
                snapshotId={subsBatch === 'snapshot' ? subsSnapshotId : undefined}
                position="bottom"
                marginVPct={8}
                fontSize={24}
                dual={subsDual}
                maxCharsPerLine={subMaxChars}
                maxLines={subMaxLines}
                maxCueDuration={subMaxCueDuration}
                apiBase={API}
                draggable={false}
              />
            </div>
          )}

          {tab === 'pkg' && (
            <div className="export-modal__pkg-grid">
              <PkgCard
                icon={<Package size={14} />} title="Per-segment clips (.zip)"
                body="Every generated segment as a numbered WAV inside a zip — good for review, voice-over post, or dataset building."
                onClick={runClips} cta="Export clips zip"
              />
              <PkgCard
                icon={<Layers size={14} />} title="Stems (.zip)"
                body="Isolated vocal track + background (music/FX) as separate WAVs. Useful for downstream audio editing."
                onClick={runStems} cta="Export stems zip"
              />
              <PkgCard
                icon={<Music size={14} />} title="Audio tracks (individual files)"
                body={`Jump to the Audio tab to export per-language dubs in WAV or MP3 (${(dubTracks || []).length} dub${(dubTracks || []).length === 1 ? '' : 's'} available).`}
                onClick={() => setTab('audio')} cta="Open audio tab"
                ghost
              />
            </div>
          )}
        </div>

        {/* Commercial license notice */}
        <div className="export-modal__license-notice">
          <Building2 size={11} />
          <span>Commercial use requires a <button type="button" className="export-modal__license-link" onClick={() => { onClose(); onEnterprise?.(); }}>license</button>.</span>
        </div>

        {/* Summary footer */}
        <div className="export-modal__summary">
          <div className="export-modal__summary-left">
            <span className="export-modal__kicker">OUTPUT</span>
            <code className="export-modal__summary-name" title={filenamePreview}>{filenamePreview}</code>
          </div>
          <div className="export-modal__summary-right">
            {tab !== 'pkg' && (
              <>
                <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
                <Button
                  variant="primary" size="sm"
                  onClick={active.fn} disabled={!active.can}
                  leading={<Download size={11} />}
                  title={active.can ? '' : 'Nothing selected or track unavailable'}
                >
                  {active.label}
                </Button>
              </>
            )}
            {tab === 'pkg' && (
              <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>,
    document.body,
  );
}

function SubGroup({ title, children }) {
  return (
    <div className="export-modal__sub-group">
      <div className="export-modal__sub-group-title">{title}</div>
      <div className="export-modal__sub-group-body">{children}</div>
    </div>
  );
}

function SubRow({ label, children }) {
  return (
    <div className="export-modal__sub-row">
      <div className="export-modal__sub-row-label">{label}</div>
      <div className="export-modal__sub-row-control">{children}</div>
    </div>
  );
}

function Field({ label, hint, children, className = '' }) {
  return (
    <div className={`export-modal__field ${className}`}>
      <div className="export-modal__field-head">
        <span className="export-modal__field-label">{label}</span>
        {hint && <span className="export-modal__field-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function BgControls({
  bgSource, setBgSource,
  bgVolume, setBgVolume,
  customBgInfo, uploadingBg,
  onUpload, onDelete,
}) {
  return (
    <div className="export-modal__bg">
      <Segmented
        size="sm"
        value={bgSource}
        onChange={setBgSource}
        items={[
          { value: 'original', label: 'Original (Demucs)', title: 'Nhạc nền tách từ video gốc' },
          { value: 'custom', label: 'Custom file', title: 'Upload nhạc nền của bạn' },
          { value: 'off', label: 'Off', title: 'Không trộn nhạc nền — chỉ giọng dub' },
        ]}
      />

      {bgSource === 'custom' && (
        <div className="export-modal__bg-custom">
          {customBgInfo.exists ? (
            <div className="export-modal__bg-file">
              <span className="export-modal__bg-filename" title={customBgInfo.filename}>
                🎵 {customBgInfo.filename}
              </span>
              <span className="export-modal__bg-size">
                {Math.round((customBgInfo.size_bytes || 0) / 1024)} KB
              </span>
              <button type="button" className="export-modal__bg-btn" onClick={onUpload} disabled={uploadingBg}>
                {uploadingBg ? 'Uploading…' : 'Thay file'}
              </button>
              <button type="button" className="export-modal__bg-btn export-modal__bg-btn--danger" onClick={onDelete}>
                Xoá
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="export-modal__bg-upload"
              onClick={onUpload}
              disabled={uploadingBg}
            >
              {uploadingBg ? 'Đang upload…' : '⬆️ Chọn file nhạc nền (mp3/wav/m4a…)'}
            </button>
          )}
        </div>
      )}

      {bgSource !== 'off' && (
        <div className="export-modal__bg-volume">
          <label className="export-modal__bg-vol-label">
            BG volume <span style={{ fontFamily: 'monospace' }}>{bgVolume}%</span>
          </label>
          <input
            type="range" min="0" max="200" step="5"
            value={bgVolume}
            onChange={(e) => setBgVolume(Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--accent, #d3869b)' }}
          />
          <span className="export-modal__bg-vol-hint">
            {bgVolume === 0 ? 'mute' : bgVolume < 50 ? 'rất nhẹ' : bgVolume <= 100 ? 'cân bằng' : 'lấn giọng'}
          </span>
        </div>
      )}
    </div>
  );
}

function PkgCard({ icon, title, body, onClick, cta, ghost = false }) {
  return (
    <div className={`export-modal__pkg-card ${ghost ? 'is-ghost' : ''}`}>
      <div className="export-modal__pkg-head">{icon}<span>{title}</span></div>
      <p className="export-modal__pkg-body">{body}</p>
      <Button variant={ghost ? 'subtle' : 'primary'} size="sm" onClick={onClick} leading={ghost ? null : <Check size={10} />}>
        {cta}
      </Button>
    </div>
  );
}
