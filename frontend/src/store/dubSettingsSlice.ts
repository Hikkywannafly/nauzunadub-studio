/**
 * Dub-mix tuning slice.
 *
 * Exposes the previously hardcoded mix-time + speed-fit knobs so power users
 * can tune them from the Dub Settings modal. Defaults match the constants
 * tuned in backend `dub_generate.py` and `speech_rate.py` — leaving them
 * untouched reproduces current behaviour exactly.
 *
 * All fields persist via the root store's `partialize` whitelist.
 */
import type { StateCreator } from 'zustand';

export interface DubSettings {
  // Mix-time fades & tail (xem dub_generate.py:36-38)
  startFadeMs: number;        // default 15
  endFadeMs: number;          // default 50
  tailAllowanceS: number;     // default 0.25

  // Speed slot-fit clamp (xem dub_generate.py:305)
  slotFactorMin: number;      // default 0.85
  slotFactorMax: number;      // default 1.25

  // Mix-time fit mode khi audio dài hơn slot
  slotFit: 'time_stretch' | 'trim' | 'off';

  // Khi audio NGẮN hơn slot — mặc định để khoảng lặng cuối seg.
  //   off         — giữ silence cuối (default, không phá hành vi cũ)
  //   stretch_up  — time-stretch giọng dài ra cho khớp `end`
  //   anchor_end  — giữ độ dài tự nhiên, dồn silence về ĐẦU seg
  fillSlotMode: 'off' | 'stretch_up' | 'anchor_end';

  // Master switch — override tất cả 3 tầng scaling khi != "fit_slot"
  //   fit_slot   — scale theo slot (default, dùng các knob ở trên)
  //   natural    — KHÔNG scale, giọng đọc tự nhiên, neo theo seg.start
  //                (audio dài hơn slot → overlap seg kế)
  //   sequential — KHÔNG scale, nhưng nếu seg N tràn → đẩy seg N+1 lùi
  //                cho không overlap (audio cuối có thể dài hơn video gốc)
  ttsPacing: 'fit_slot' | 'natural' | 'sequential';
}

export const DUB_SETTINGS_DEFAULTS: DubSettings = {
  startFadeMs: 15,
  endFadeMs: 50,
  tailAllowanceS: 0.25,
  slotFactorMin: 0.85,
  slotFactorMax: 1.25,
  slotFit: 'time_stretch',
  fillSlotMode: 'off',
  ttsPacing: 'fit_slot',
};

export interface DubSettingsSlice {
  dubSettings: DubSettings;
  setDubSettings: (patch: Partial<DubSettings>) => void;
  resetDubSettings: () => void;
}

export const createDubSettingsSlice: StateCreator<DubSettingsSlice, [], [], DubSettingsSlice> = (set) => ({
  dubSettings: { ...DUB_SETTINGS_DEFAULTS },
  setDubSettings: (patch) => set((s) => ({ dubSettings: { ...s.dubSettings, ...patch } })),
  resetDubSettings: () => set({ dubSettings: { ...DUB_SETTINGS_DEFAULTS } }),
});
