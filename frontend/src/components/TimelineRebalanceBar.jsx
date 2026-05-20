import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, Zap, Undo2, ChevronDown, Loader, Wand2 } from 'lucide-react';
import {
  rebalanceTimeline,
  listTimelineSnapshots,
  restoreTimelineSnapshot,
  deleteTimelineSnapshot,
  autoFixJob,
} from '../api/dub';
import { useAppStore } from '../store';
import { Segmented } from '../ui';
import { rateRatio as computeRateRatio, severityTier } from '../api/segmentRate';
import toast from 'react-hot-toast';
import './TranslationHistoryPicker.css';

/**
 * TimelineRebalanceBar — toolbar group cho cơ chế redistribute timeline.
 *
 * Mode:
 *   - Even (instant, deterministic): borrow time giữa các seg cùng "run" theo
 *     trọng số char count. Tổng thời lượng từng run KHÔNG đổi → giữ lip-sync
 *     ở chỗ pause natural.
 *   - AI (LLM): smart, lâu hơn, có thể fallback về Even nếu LLM trả invalid.
 *
 * Mỗi lần rebalance backend snapshot start/end gốc vào job_data → có thể Undo
 * trở lại cả sau F5.
 */
export default function TimelineRebalanceBar() {
  const dubJobId = useAppStore((s) => s.dubJobId);
  const dubSegments = useAppStore((s) => s.dubSegments);
  const setDubSegments = useAppStore((s) => s.setDubSegments);

  const dubLangCode = useAppStore((s) => s.dubLangCode);
  const [mode, setMode] = useState('even');
  const [running, setRunning] = useState(false);
  const [autoFixing, setAutoFixing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [restoringId, setRestoringId] = useState(null);
  const historyRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  const hasTranslated = dubSegments.some((s) => s.text_original && s.text_original !== s.text);
  const disabled = !dubJobId || !dubSegments.length || running || autoFixing || !hasTranslated;

  // Count out-of-range segs — mirror DubSegmentRow live-severity logic so the
  // button label matches the badges user sees on each row.
  const outOfRangeCount = useMemo(() => {
    if (!hasTranslated) return 0;
    const lang = (dubLangCode || 'vi').toLowerCase();
    let n = 0;
    for (const s of dubSegments) {
      const text = (s.text || '').trim();
      const slot = Math.max(0, (s.end ?? 0) - (s.start ?? 0));
      if (!text || slot <= 0) continue;
      const isTranslated = !!s.text_original && s.text !== s.text_original;
      if (!isTranslated) continue;
      const tier = severityTier(computeRateRatio(s.text || '', slot, lang));
      if (tier !== 'ok') n++;
    }
    return n;
  }, [dubSegments, dubLangCode, hasTranslated]);

  const refresh = useCallback(async () => {
    if (!dubJobId) { setSnapshots([]); return; }
    setHistoryLoading(true);
    try {
      const res = await listTimelineSnapshots(dubJobId);
      setSnapshots(res.snapshots || []);
    } catch (err) {
      if (!String(err?.message || '').match(/404|not found/i)) {
        toast.error(`Không tải được history: ${err.message || err}`);
      }
      setSnapshots([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [dubJobId]);

  useEffect(() => { if (historyOpen) refresh(); }, [historyOpen, refresh]);

  useEffect(() => {
    if (!historyOpen) return;
    const onDown = (e) => {
      // Đóng nếu click ngoài cả trigger lẫn menu (menu render qua portal)
      const inTrigger = historyRef.current?.contains(e.target);
      const inMenu = menuRef.current?.contains(e.target);
      if (!inTrigger && !inMenu) setHistoryOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setHistoryOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [historyOpen]);

  // Position menu relative to trigger via viewport coords — menu renders in
  // body so no ancestor overflow can clip it. Re-measure on scroll/resize.
  useLayoutEffect(() => {
    if (!historyOpen || !triggerRef.current) return;
    const measure = () => {
      const r = triggerRef.current.getBoundingClientRect();
      const menuW = 320;
      const left = Math.max(8, Math.min(window.innerWidth - menuW - 8, r.right - menuW));
      setMenuPos({ top: r.bottom + 4, left });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [historyOpen]);

  const handleAutoFix = async () => {
    if (!dubJobId || outOfRangeCount === 0) return;
    setAutoFixing(true);
    const toastId = toast.loading(
      `Auto-fix ${outOfRangeCount} seg: rebalance + LLM optimize…`,
    );
    try {
      const res = await autoFixJob(dubJobId, { rebalance: true });
      // Backend trả `segments` đã apply cả rebalance (timing) + optimize (text).
      // Normalize id giống các hàm khác để store hoạt động đúng.
      if (Array.isArray(res.segments)) {
        const segs = res.segments.map((s, i) => ({
          ...s,
          id: s.id != null ? String(s.id) : String(i),
        }));
        setDubSegments(segs);
      }

      const reb = res.rebalance;
      const opt = res.optimize;
      const rebSummary = reb
        ? `rebalanced ${reb.stats?.shifted ?? 0} seg (CPS ${reb.before?.max_cps}→${reb.after?.max_cps})`
        : 'skip rebalance';
      const optSummary = `optimized ${opt?.fixed ?? 0} text${opt?.failed ? `, ${opt.failed} fail` : ''}${opt?.unchanged ? `, ${opt.unchanged} chưa đổi` : ''}`;
      toast.success(
        `✓ Auto-fix xong · ${rebSummary} · ${optSummary}. Bấm Generate để regen TTS.`,
        { id: toastId, duration: 8000 },
      );
    } catch (err) {
      toast.error(`Auto-fix thất bại: ${err.message || err}`, { id: toastId });
    } finally {
      setAutoFixing(false);
    }
  };

  const handleApply = async () => {
    if (!dubJobId) return;
    setRunning(true);
    const toastId = toast.loading(`Đang ${mode === 'ai' ? 'AI rebalance' : 'phân lại'} timeline…`);
    try {
      const res = await rebalanceTimeline(dubJobId, mode);
      const segs = (res.segments || []).map((s, i) => ({
        ...s,
        id: s.id != null ? String(s.id) : String(i),
      }));
      setDubSegments(segs);
      const fallback = res.stats?.fallback_reason
        ? ` (fallback Even: ${res.stats.fallback_reason})` : '';
      toast.success(
        `✓ Rebalanced ${res.stats.shifted}/${res.stats.total_segs} seg · ` +
        `max drift ${res.stats.max_drift_s.toFixed(2)}s · ` +
        `CPS ${res.before.max_cps}→${res.after.max_cps}${fallback}`,
        { id: toastId, duration: 6000 },
      );
    } catch (err) {
      toast.error(`Rebalance thất bại: ${err.message || err}`, { id: toastId });
    } finally {
      setRunning(false);
    }
  };

  const handleRestore = async (snap) => {
    if (!dubJobId) return;
    setRestoringId(snap.id);
    try {
      const res = await restoreTimelineSnapshot(dubJobId, snap.id);
      const segs = (res.segments || []).map((s, i) => ({
        ...s,
        id: s.id != null ? String(s.id) : String(i),
      }));
      setDubSegments(segs);
      toast.success(`Đã revert timeline về snapshot "${snap.mode}"`);
      setHistoryOpen(false);
    } catch (err) {
      toast.error(`Restore thất bại: ${err.message || err}`);
    } finally {
      setRestoringId(null);
    }
  };

  const handleDelete = async (snap, e) => {
    e.stopPropagation();
    if (!dubJobId) return;
    if (!window.confirm(`Xoá timeline snapshot "${snap.mode}"?`)) return;
    try {
      await deleteTimelineSnapshot(dubJobId, snap.id);
      setSnapshots((prev) => prev.filter((s) => s.id !== snap.id));
    } catch (err) {
      toast.error(`Xoá thất bại: ${err.message || err}`);
    }
  };

  return (
    <div className="timeline-rebalance-bar">
      <span
        className="timeline-rebalance-bar__label"
        title="Phân lại start/end của các segment để CPS đều xuyên suốt — giọng dub không bị gấp ở chỗ text dài. Snapshot gốc lưu trong job → Undo được."
      >
        <Sparkles size={10} /> Auto timeline
      </span>
      <Segmented
        size="sm"
        value={mode}
        onChange={setMode}
        items={[
          { value: 'even', label: 'Even', title: 'Algorithmic, instant, deterministic' },
          { value: 'ai', label: 'AI', title: 'LLM-assisted; fallback về Even nếu invalid' },
        ]}
      />
      <button
        type="button"
        className="timeline-rebalance-bar__apply"
        onClick={handleApply}
        disabled={disabled}
        title={
          !hasTranslated
            ? 'Translate trước khi rebalance — timeline chỉ ý nghĩa với text đích'
            : `Áp dụng ${mode === 'ai' ? 'AI' : 'Even'} rebalance`
        }
      >
        {running ? <Loader size={11} className="spinner" /> : <Zap size={11} />}
        <span>Apply</span>
      </button>

      {/* Auto-fix: Rebalance Even + LLM optimize cho mọi seg out-of-range */}
      <button
        type="button"
        className="timeline-rebalance-bar__autofix"
        onClick={handleAutoFix}
        disabled={disabled || outOfRangeCount === 0}
        title={
          !hasTranslated
            ? 'Translate trước khi auto-fix'
            : outOfRangeCount === 0
              ? 'Mọi segment đã trong khoảng 85–115% — không cần auto-fix'
              : `Auto-fix ${outOfRangeCount} seg out-of-range: rebalance Even + LLM optimize text. Sau đó cần bấm Generate để regen TTS.`
        }
      >
        {autoFixing ? <Loader size={11} className="spinner" /> : <Wand2 size={11} />}
        <span>
          Auto-fix{outOfRangeCount > 0 ? ` (${outOfRangeCount})` : ''}
        </span>
      </button>

      <div className="tr-history-picker" ref={historyRef}>
        <button
          type="button"
          ref={triggerRef}
          className="tr-history-picker__btn tr-history-picker__btn--sm"
          onClick={() => setHistoryOpen((o) => !o)}
          disabled={!dubJobId}
          title="Undo / xem các lần rebalance trước"
        >
          <Undo2 size={11} />
          <span>Undo</span>
          <ChevronDown size={9} className={`tr-history-picker__caret ${historyOpen ? 'is-open' : ''}`} />
        </button>
        {historyOpen && createPortal(
          <div
            ref={menuRef}
            className="tr-history-picker__menu tr-history-picker__menu--portal"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            <div className="tr-history-picker__head">
              <strong>Timeline snapshots</strong>
              <span className="tr-history-picker__count">
                {historyLoading ? '…' : `${snapshots.length} bản`}
              </span>
            </div>
            {historyLoading ? (
              <div className="tr-history-picker__empty">Đang tải…</div>
            ) : snapshots.length === 0 ? (
              <div className="tr-history-picker__empty">
                Chưa có lần rebalance nào để revert.
              </div>
            ) : (
              <ul className="tr-history-picker__list">
                {snapshots.map((snap) => {
                  const isRestoring = restoringId === snap.id;
                  return (
                    <li key={snap.id} className="tr-history-picker__item">
                      <button
                        type="button"
                        className="tr-history-picker__row"
                        onClick={() => !isRestoring && handleRestore(snap)}
                        disabled={isRestoring}
                      >
                        <div className="tr-history-picker__row-main">
                          <span className="tr-history-picker__lang">{(snap.mode || '?').toUpperCase()}</span>
                          <span className="tr-history-picker__meta">snapshot trước rebalance</span>
                        </div>
                        <div className="tr-history-picker__row-sub">
                          <span>{formatRelative(snap.created_at)}</span>
                        </div>
                      </button>
                      <div className="tr-history-picker__row-actions">
                        {isRestoring ? (
                          <span className="tr-history-picker__loading">…</span>
                        ) : (
                          <button
                            type="button"
                            className="tr-history-picker__icon-btn tr-history-picker__icon-btn--danger"
                            onClick={(e) => handleDelete(snap, e)}
                            title="Xoá snapshot"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>,
          document.body,
        )}
      </div>
    </div>
  );
}

function formatRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return 'vừa xong';
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  return new Date(ts * 1000).toLocaleDateString();
}
