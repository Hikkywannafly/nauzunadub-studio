import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, RotateCcw, Trash2, ChevronDown } from 'lucide-react';
import {
  listTranslationSnapshots,
  restoreTranslationSnapshot,
  deleteTranslationSnapshot,
} from '../api/dub';
import { useAppStore } from '../store';
import toast from 'react-hot-toast';
import './TranslationHistoryPicker.css';

/**
 * TranslationHistoryPicker — small dropdown that lists past translation
 * snapshots for the active dub job. Backend persists one snapshot per
 * successful /dub/translate completion (capped at 10 per job).
 *
 * Click a row → restore that translation onto the current segments. The
 * snapshot persists in job_data, so F5 / reopen-from-sidebar reads the
 * latest snapshot list back.
 */
export default function TranslationHistoryPicker({ size = 'sm' }) {
  const dubJobId = useAppStore((s) => s.dubJobId);
  const setDubSegments = useAppStore((s) => s.setDubSegments);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [restoringId, setRestoringId] = useState(null);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  const refresh = useCallback(async () => {
    if (!dubJobId) { setSnapshots([]); return; }
    setLoading(true);
    try {
      const res = await listTranslationSnapshots(dubJobId);
      setSnapshots(res.snapshots || []);
    } catch (err) {
      // 404 thường xảy ra trên job mới chưa translate — không hiển thị toast
      // làm phiền. Lỗi khác (5xx) thì show.
      if (!String(err?.message || '').match(/404|not found/i)) {
        toast.error(`Không tải được history: ${err.message || err}`);
      }
      setSnapshots([]);
    } finally {
      setLoading(false);
    }
  }, [dubJobId]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      const inRoot = rootRef.current?.contains(e.target);
      const inMenu = menuRef.current?.contains(e.target);
      if (!inRoot && !inMenu) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
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
  }, [open]);

  const handleRestore = async (snap) => {
    if (!dubJobId) return;
    setRestoringId(snap.id);
    try {
      const res = await restoreTranslationSnapshot(dubJobId, snap.id);
      // Hydrate full segments from backend (carries new text + text_original
      // + translate_literal etc.). Coerce id to string to match frontend
      // expectation downstream.
      const segs = (res.segments || []).map((s, i) => ({
        ...s,
        id: s.id != null ? String(s.id) : String(i),
        text_original: s.text_original || s.text || '',
      }));
      setDubSegments(segs);
      const skipMsg = res.skipped_errors
        ? ` (${res.skipped_errors} segment lỗi đã bỏ qua)`
        : '';
      if (res.applied === 0) {
        toast(
          `Snapshot "${describeSnap(snap)}" không có translation hợp lệ — không thay đổi gì.${skipMsg}`,
          { icon: 'ℹ️', duration: 6000 },
        );
      } else {
        toast.success(`Đã restore ${res.applied} segment từ "${describeSnap(snap)}"${skipMsg}`);
      }
      setOpen(false);
    } catch (err) {
      toast.error(`Restore thất bại: ${err.message || err}`);
    } finally {
      setRestoringId(null);
    }
  };

  const handleDelete = async (snap, e) => {
    e.stopPropagation();
    if (!dubJobId) return;
    if (!window.confirm(`Xoá snapshot "${describeSnap(snap)}"?`)) return;
    try {
      await deleteTranslationSnapshot(dubJobId, snap.id);
      setSnapshots(prev => prev.filter(s => s.id !== snap.id));
      toast.success('Đã xoá snapshot');
    } catch (err) {
      toast.error(`Xoá thất bại: ${err.message || err}`);
    }
  };

  const disabled = !dubJobId;

  return (
    <div className="tr-history-picker" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`tr-history-picker__btn tr-history-picker__btn--${size}`}
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title={disabled ? 'Cần có job đang active' : 'Lịch sử translate cho video này'}
      >
        <History size={11} />
        <span>History</span>
        <ChevronDown size={9} className={`tr-history-picker__caret ${open ? 'is-open' : ''}`} />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className="tr-history-picker__menu tr-history-picker__menu--portal"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          <div className="tr-history-picker__head">
            <strong>Translation history</strong>
            <span className="tr-history-picker__count">
              {loading ? '…' : `${snapshots.length} bản`}
            </span>
          </div>

          {loading ? (
            <div className="tr-history-picker__empty">Đang tải…</div>
          ) : snapshots.length === 0 ? (
            <div className="tr-history-picker__empty">
              Chưa có bản dịch nào lưu cho video này.
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
                      title="Click để restore translation này"
                    >
                      <div className="tr-history-picker__row-main">
                        <span className="tr-history-picker__lang">
                          {(snap.target_lang || '?').toUpperCase()}
                        </span>
                        <span className="tr-history-picker__meta">
                          {snap.provider || '—'} · {snap.quality || 'fast'}
                          {snap.genre ? ` · ${snap.genre}` : ''}
                        </span>
                      </div>
                      <div className="tr-history-picker__row-sub">
                        <span>{snap.applied_count ?? snap.segments_count} seg</span>
                        <span>· {formatRelative(snap.created_at)}</span>
                      </div>
                    </button>
                    <div className="tr-history-picker__row-actions">
                      {isRestoring ? (
                        <span className="tr-history-picker__loading">…</span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="tr-history-picker__icon-btn"
                            onClick={() => handleRestore(snap)}
                            title="Restore"
                          >
                            <RotateCcw size={11} />
                          </button>
                          <button
                            type="button"
                            className="tr-history-picker__icon-btn tr-history-picker__icon-btn--danger"
                            onClick={(e) => handleDelete(snap, e)}
                            title="Xoá snapshot"
                          >
                            <Trash2 size={11} />
                          </button>
                        </>
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
  );
}

function describeSnap(snap) {
  return `${(snap.target_lang || '?').toUpperCase()} · ${snap.provider || '—'} · ${snap.quality || 'fast'}`;
}

function formatRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return 'vừa xong';
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  const d = new Date(ts * 1000);
  return d.toLocaleDateString();
}
