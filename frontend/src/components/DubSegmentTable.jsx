import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { List } from 'react-window';
import DubSegmentRow from './DubSegmentRow';
import { Table, Select } from '../ui';
import { rateRatio as computeRateRatio, severityTier } from '../api/segmentRate';
import './DubSegmentTable.css';

// ── Row-height math ───────────────────────────────────────────────────
// react-window needs a precise height per row else content bleeds into
// the next row's slot. We compute MAX of text-col and time-col heights:
//   - text col grows by ORIG_LINE_H when text_original ≠ text
//   - time col grows by BADGE_LINE_H per stacked badge (sync / rate / fit)
//
// Numbers tuned to actual rendered heights in DubSegmentRow.css. If you
// change badge font-size or padding, retune these or rows will misalign.
const BASE_ROW_HEIGHT = 28;       // baseline: input + row padding
const ORIG_LINE_H = 14;           // .seg-orig-row (font 0.55rem + gap)
const BADGE_LINE_H = 13;          // .seg-sync/rate/fit-badge (font ~0.5rem + 2px margin)

// Spkr column: 75px is the sweet spot — fits "Speaker 1" without ellipsis,
// doesn't crowd Text. Inline edit is still allowed so users can rename a
// speaker without leaving the table.
const COLUMNS = [
  { key: 'time',  label: 'Time',  width: 100 },
  { key: 'spkr',  label: 'Spkr',  width: 75 },
  { key: 'text',  label: 'Text',  flex: 1 },
  { key: 'lang',  label: 'Lang',  width: 42 },
  { key: 'voice', label: 'Voice', width: 60 },
  { key: 'vol',   label: 'Vol',   width: 40, title: 'Volume (0–200%)' },
  { key: 'act',   label: '',      width: 42 },
];

export default function DubSegmentTable({
  segments, profiles, speakerClones, dubStep, dubProgress, previewLoadingId,
  selectedIds, onSelect, onSelectAll, onClearSelection,
  onEditField, onDelete, onRestore, onPreview, onSplit, onMerge, onDirect, onSeek,
  onShorten, dubLangCode, shorteningId,
}) {
  const disabled = dubStep === 'generating' || dubStep === 'stopping';
  const [query, setQuery] = useState('');
  const [speakerFilter, setSpeakerFilter] = useState('');

  // react-window v2 needs a concrete height prop — CSS 100 % doesn't cut it.
  // Measure the body container and pass its height explicitly so the list
  // renders every row that fits, not just a default-sized window.
  const bodyRef = useRef(null);
  const [bodyHeight, setBodyHeight] = useState(0);
  useLayoutEffect(() => {
    if (!bodyRef.current) return;
    const measure = () => {
      const h = bodyRef.current?.clientHeight || 0;
      setBodyHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bodyRef.current);
    return () => ro.disconnect();
  }, []);

  const speakers = useMemo(() => {
    const s = new Set(segments.map(x => x.speaker_id).filter(Boolean));
    return Array.from(s).sort();
  }, [segments]);

  const filtered = useMemo(() => {
    if (!query && !speakerFilter) return segments;
    const q = query.trim().toLowerCase();
    return segments.filter(s => {
      if (speakerFilter && s.speaker_id !== speakerFilter) return false;
      if (!q) return true;
      return (s.text && s.text.toLowerCase().includes(q))
        || (s.text_original && s.text_original.toLowerCase().includes(q));
    });
  }, [segments, query, speakerFilter]);

  const rowHeight = useCallback((index) => {
    const s = filtered[index];
    if (!s) return BASE_ROW_HEIGHT;

    // Text column extras
    const hasOrig = !!s.text_original && s.text_original !== s.text;
    const textExtra = hasOrig ? ORIG_LINE_H : 0;

    // Time column extras: count badges that DubSegmentRow will render.
    // Logic must mirror DubSegmentRow.jsx visibility conditions exactly,
    // else row height under/over-estimates → bleed into next row.
    let badgeCount = 0;
    if (s.sync_ratio !== undefined) badgeCount++;
    if (s.rate_ratio != null && Math.abs(s.rate_ratio - 1.0) > 0.03) badgeCount++;
    // Fit badge: only when translated + severity != ok + text non-empty + slot > 0
    if (hasOrig) {
      const slot = Math.max(0, (s.end ?? 0) - (s.start ?? 0));
      const text = (s.text || '').trim();
      if (text.length > 0 && slot > 0) {
        const lang = (s.target_lang || dubLangCode || 'vi').toLowerCase();
        const ratio = computeRateRatio(s.text || '', slot, lang);
        if (severityTier(ratio) !== 'ok') badgeCount++;
      }
    }
    const timeExtra = badgeCount * BADGE_LINE_H;

    return BASE_ROW_HEIGHT + Math.max(textExtra, timeExtra);
  }, [filtered, dubLangCode]);

  const rowProps = useMemo(() => ({
    filtered, profiles, speakerClones, disabled, dubStep, dubProgress, previewLoadingId,
    selectedIds, onSelect, onEditField, onDelete, onRestore, onPreview, onSplit, onMerge, onDirect, onSeek,
    onShorten, dubLangCode, shorteningId,
    segments,
  }), [filtered, profiles, speakerClones, disabled, dubStep, dubProgress, previewLoadingId,
      selectedIds, onSelect, onEditField, onDelete, onRestore, onPreview, onSplit, onMerge, onDirect, onSeek,
      onShorten, dubLangCode, shorteningId, segments]);

  const Row = useCallback(({ index, style, filtered: fl, profiles: profs, speakerClones: clones, disabled: dis, dubProgress: prog, dubStep: step, previewLoadingId: previewId, selectedIds: sel, onSelect: pick, onEditField: edit, onDelete: del, onRestore: rest, onPreview: prev, onSplit: split, onMerge: merge, onDirect: direct, onSeek: seek, onShorten: shorten, dubLangCode: lang, shorteningId: shortId, segments: segs }) => {
    const seg = fl[index];
    if (!seg) return null;
    const absoluteIndex = segs.indexOf(seg);
    const isActive = (step === 'generating' || step === 'stopping') && prog.current === absoluteIndex + 1;
    const isDone = (step === 'generating' || step === 'stopping') && prog.current > absoluteIndex + 1;
    const canMerge = index < fl.length - 1;
    return (
      <DubSegmentRow
        seg={seg} idx={index} style={style}
        disabled={dis} isActive={isActive} isDone={isDone}
        previewLoading={previewId === seg.id}
        selected={sel && sel.has(seg.id)}
        canMerge={canMerge}
        profiles={profs}
        speakerClones={clones}
        onEditField={edit} onDelete={del} onRestore={rest} onPreview={prev}
        onSelect={pick} onSplit={split} onMerge={merge} onDirect={direct} onSeek={seek}
        onShorten={shorten} dubLangCode={lang} shorteningId={shortId}
      />
    );
  }, []);

  const allFilteredSelected = filtered.length > 0 && filtered.every(s => selectedIds && selectedIds.has(s.id));
  const selCount = selectedIds?.size ?? 0;
  const meta = (
    <>
      {filtered.length}/{segments.length}
      {selCount > 0 && <span className="dub-segment-table__sel-count"> · {selCount} sel</span>}
    </>
  );

  return (
    <Table className="segment-table">
      <Table.Toolbar
        search={query}
        onSearch={setQuery}
        searchPlaceholder="Search text…"
        meta={meta}
      >
        {speakers.length > 1 && (
          <Select
            size="sm"
            value={speakerFilter}
            onChange={(e) => setSpeakerFilter(e.target.value)}
            className="dub-segment-table__spk-filter"
          >
            <option value="">All speakers</option>
            {speakers.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
        )}
      </Table.Toolbar>

      <Table.Header
        className="dub-segment-table__header"
        columns={COLUMNS}
        leading={
          <span className="dub-segment-table__select-all">
            <input
              type="checkbox"
              checked={allFilteredSelected}
              onChange={(e) => e.target.checked ? onSelectAll(filtered) : onClearSelection()}
              title="Select all filtered"
            />
          </span>
        }
      />

      <div className="dub-segment-table__body" ref={bodyRef}>
        {bodyHeight > 0 && (
          <List
            rowCount={filtered.length}
            rowHeight={rowHeight}
            rowComponent={Row}
            rowProps={rowProps}
            overscanCount={6}
            style={{ height: bodyHeight, width: '100%' }}
          />
        )}
      </div>
    </Table>
  );
}
