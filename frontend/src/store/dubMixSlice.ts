/**
 * Dub mix-time / generation options slice — split from dubSlice.
 *
 * dubSlice grew to ~20 setters spanning pipeline progress (jobId, step,
 * segments, progress) AND output configuration (instruct, preserveBg,
 * exportTracks, previewSegIds). The two clusters have different lifecycles:
 *
 *   - Pipeline state is transient per session and resets between projects.
 *   - Mix options are user-configurable knobs that persist across reloads.
 *
 * Splitting them lets components subscribe to just what they need without
 * triggering re-renders when unrelated pipeline state ticks, and matches the
 * persist() partialize boundary in the root store.
 */
import type { StateCreator } from 'zustand';

type Updater<T> = T | ((prev: T) => T);

function resolve<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === 'function' ? (updater as (prev: T) => T)(prev) : updater;
}

export interface DubMixSlice {
  /** Free-form TTS instruct string applied to every segment unless overridden. */
  dubInstruct: string;
  /** Mix the demucs-separated no-vocals (BG music + ambient) back under dub audio. */
  preserveBg: boolean;
  /** Which track plays by default in the preview player ("original" or a lang code). */
  defaultTrack: string;
  /** Per-language toggle for which dubs are included in the final export. */
  exportTracks: Record<string, boolean>;
  /** Segment ids most recently rendered at preview quality (num_step=8) — need
   *  re-render at full quality before final export. */
  previewSegIds: string[];

  setDubInstruct: (v: Updater<string>) => void;
  setPreserveBg: (v: Updater<boolean>) => void;
  setDefaultTrack: (v: Updater<string>) => void;
  setExportTracks: (v: Updater<Record<string, boolean>>) => void;
  setPreviewSegIds: (v: Updater<string[]>) => void;

  resetDubMixState: () => void;
}

const INITIAL: Omit<DubMixSlice,
  | 'setDubInstruct' | 'setPreserveBg' | 'setDefaultTrack'
  | 'setExportTracks' | 'setPreviewSegIds' | 'resetDubMixState'
> = {
  dubInstruct: '',
  preserveBg: true,
  defaultTrack: 'original',
  exportTracks: { original: true },
  previewSegIds: [],
};

export const createDubMixSlice: StateCreator<DubMixSlice, [], [], DubMixSlice> = (set) => ({
  ...INITIAL,

  setDubInstruct:  (v) => set((s) => ({ dubInstruct:  resolve(v, s.dubInstruct) })),
  setPreserveBg:   (v) => set((s) => ({ preserveBg:   resolve(v, s.preserveBg) })),
  setDefaultTrack: (v) => set((s) => ({ defaultTrack: resolve(v, s.defaultTrack) })),
  setExportTracks: (v) => set((s) => ({ exportTracks: resolve(v, s.exportTracks) })),
  setPreviewSegIds:(v) => set((s) => ({ previewSegIds:resolve(v, s.previewSegIds) })),

  resetDubMixState: () => set(INITIAL),
});
