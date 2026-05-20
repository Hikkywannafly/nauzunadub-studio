import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useAppStore } from '../store';
import { DUB_SETTINGS_DEFAULTS, DUB_PRESETS, matchPreset } from '../store/dubSettingsSlice';
import { Button, Segmented, Badge } from '../ui';
import './DubSettingsModal.css';

/**
 * DubSettingsModal — bottom-drawer panel for tuning mix-time + speed-fit
 * knobs that used to be hardcoded in backend `dub_generate.py`. All values
 * are sent through DubRequest on the next generate call.
 *
 * Grouped P0 (audible) / P1 (advanced TTS knobs). Reset restores defaults
 * tuned in the backend module.
 */
export default function DubSettingsModal({ open, onClose }) {
  const dubSettings = useAppStore((s) => s.dubSettings);
  const setDubSettings = useAppStore((s) => s.setDubSettings);
  const resetDubSettings = useAppStore((s) => s.resetDubSettings);

  // Global TTS knobs sống ở generateSlice — share giữa Generate + Dub tab.
  const speed = useAppStore((s) => s.speed);
  const setSpeed = useAppStore((s) => s.setSpeed);
  const steps = useAppStore((s) => s.steps);
  const setSteps = useAppStore((s) => s.setSteps);
  const cfg = useAppStore((s) => s.cfg);
  const setCfg = useAppStore((s) => s.setCfg);

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

  if (!open) return null;

  const isDefault = (key, val) => DUB_SETTINGS_DEFAULTS[key] === val;
  const isTTSDefault = speed === 1.0 && steps === 16 && cfg === 2.0;
  const allDefault = isTTSDefault
    && Object.entries(DUB_SETTINGS_DEFAULTS).every(([k, v]) => dubSettings[k] === v);

  const onReset = () => {
    resetDubSettings();
    setSpeed(1.0);
    setSteps(16);
    setCfg(2.0);
  };

  const currentPresetId = matchPreset(dubSettings, speed, steps, cfg);
  const applyPreset = (presetId) => {
    const preset = DUB_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setDubSettings(preset.settings);
    setSpeed(preset.speed);
    setSteps(preset.steps);
    setCfg(preset.cfg);
  };

  return createPortal(
    <div className="dub-settings-drawer">
      <div ref={drawerRef} className="dub-settings-drawer__sheet">
        <div className="dub-settings-drawer__handle" />
        <div className="dub-settings-drawer__head">
          <SlidersHorizontal size={14} />
          <strong>Dub Settings</strong>
          <Badge tone="neutral" size="xs">Persisted</Badge>
          <span className="dub-settings-drawer__hint">
            Áp dụng cho lần Generate tiếp theo
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={onReset}
            disabled={allDefault}
            title="Khôi phục mọi giá trị về mặc định"
          >
            <RotateCcw size={11} /> Reset
          </Button>
          <button className="dub-settings-drawer__close" onClick={onClose} title="Close (Esc)">
            <X size={14} />
          </button>
        </div>

        {/* ─── Preset selector — quick-switch giữa lip-sync / fast-pace ── */}
        <div className="dub-settings-presets">
          <div className="dub-settings-presets__label">Preset</div>
          <div className="dub-settings-presets__list">
            {DUB_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`dub-settings-preset ${currentPresetId === p.id ? 'is-active' : ''}`}
                onClick={() => applyPreset(p.id)}
                title={p.description}
              >
                <span className="dub-settings-preset__name">{p.name}</span>
                <span className="dub-settings-preset__desc">{p.description}</span>
              </button>
            ))}
            {currentPresetId === null && (
              <div className="dub-settings-preset is-custom" title="Bạn đã chỉnh tay — không khớp preset nào">
                <span className="dub-settings-preset__name">Custom</span>
                <span className="dub-settings-preset__desc">Giá trị hiện tại đã chỉnh tay.</span>
              </div>
            )}
          </div>
        </div>

        <div className="dub-settings-drawer__body">
          {/* ─── P0: Mix-time (ảnh hưởng nghe rõ nhất) ──────────── */}
          <section className="dub-settings-section">
            <h4>Mix-time fitting</h4>
            <p className="dub-settings-section__desc">
              Điều khiển cách ghép từng segment vào timeline cuối.
            </p>

            <Row
              label="TTS pacing (master)"
              hint="Fit slot: scale theo slot (default). Natural: không scale, audio dài tràn qua seg kế (overlap). Sequential: không scale, nhưng đẩy seg kế lùi nếu seg trước tràn — KHÔNG overlap, audio cuối có thể dài hơn video gốc."
              isDefault={isDefault('ttsPacing', dubSettings.ttsPacing)}
            >
              <Segmented
                size="sm"
                value={dubSettings.ttsPacing}
                onChange={(v) => setDubSettings({ ttsPacing: v })}
                items={[
                  { value: 'fit_slot', label: 'Fit slot', title: 'Scale theo slot duration (default)' },
                  { value: 'natural', label: 'Natural', title: 'Không scale, cho phép overlap' },
                  { value: 'sequential', label: 'Sequential', title: 'Không scale, đẩy seg kế lùi để tránh overlap. Lip-sync drift dần.' },
                ]}
              />
            </Row>

            {dubSettings.ttsPacing !== 'fit_slot' && (
              <div className="dub-settings-row__hint" style={{ padding: '6px 10px', background: 'rgba(250,189,47,0.08)', borderLeft: '3px solid #fabd2f', borderRadius: '4px' }}>
                {dubSettings.ttsPacing === 'natural' ? (
                  <>⚠️ <strong>Natural</strong> đang bật — mọi setting Slot-fit / Fill-slot / Speed slot-fit bên dưới <strong>không có tác dụng</strong>. Audio dài hơn slot sẽ <strong>overlap</strong> seg kế.</>
                ) : (
                  <>⚠️ <strong>Sequential</strong> đang bật — Slot-fit / Fill-slot / Speed slot-fit bên dưới <strong>không có tác dụng</strong>. Seg kế tự lùi để tránh overlap → audio cuối phim có thể <strong>dài hơn video gốc</strong>, lip-sync drift dần.</>
                )}
              </div>
            )}

            <Row
              label="Slot-fit mode (audio DÀI hơn slot)"
              hint="Cách xử lý khi giọng TTS dài hơn slot"
              isDefault={isDefault('slotFit', dubSettings.slotFit)}
            >
              <Segmented
                size="sm"
                value={dubSettings.slotFit}
                onChange={(v) => setDubSettings({ slotFit: v })}
                items={[
                  { value: 'time_stretch', label: 'Stretch', title: 'Resample fit slot (default)' },
                  { value: 'trim', label: 'Trim', title: 'Cắt cụt + fade' },
                  { value: 'off', label: 'Off', title: 'Cho overlap legacy' },
                ]}
              />
            </Row>

            <Row
              label="Fill-slot mode (audio NGẮN hơn slot)"
              hint="Mặc định off — để khoảng lặng cuối seg. Stretch-up kéo giọng dài ra cho khớp end; Anchor-end giữ độ dài tự nhiên nhưng align về cuối slot."
              isDefault={isDefault('fillSlotMode', dubSettings.fillSlotMode)}
            >
              <Segmented
                size="sm"
                value={dubSettings.fillSlotMode}
                onChange={(v) => setDubSettings({ fillSlotMode: v })}
                items={[
                  { value: 'off', label: 'Off', title: 'Silence cuối seg (default)' },
                  { value: 'stretch_up', label: 'Stretch-up', title: 'Time-stretch giọng dài ra cho khớp end (pitch trầm nhẹ)' },
                  { value: 'anchor_end', label: 'Anchor-end', title: 'Giữ độ dài tự nhiên, dồn silence về đầu seg' },
                ]}
              />
            </Row>

            <Slider
              label="Tail allowance"
              hint="Cho audio tràn vào gap trước seg kế (tối đa, giây)"
              min={0} max={1.0} step={0.05}
              value={dubSettings.tailAllowanceS}
              onChange={(v) => setDubSettings({ tailAllowanceS: v })}
              format={(v) => `${v.toFixed(2)} s`}
              isDefault={isDefault('tailAllowanceS', dubSettings.tailAllowanceS)}
              defaultValue={DUB_SETTINGS_DEFAULTS.tailAllowanceS}
              onResetDefault={() => setDubSettings({ tailAllowanceS: DUB_SETTINGS_DEFAULTS.tailAllowanceS })}
            />

            <Slider
              label="Fade-out cuối seg"
              hint="Che chỗ trim. Càng dài càng mượt nhưng cuối câu dễ bị nuốt"
              min={0} max={200} step={5}
              value={dubSettings.endFadeMs}
              onChange={(v) => setDubSettings({ endFadeMs: v })}
              format={(v) => `${v} ms`}
              isDefault={isDefault('endFadeMs', dubSettings.endFadeMs)}
              defaultValue={DUB_SETTINGS_DEFAULTS.endFadeMs}
              onResetDefault={() => setDubSettings({ endFadeMs: DUB_SETTINGS_DEFAULTS.endFadeMs })}
            />

            <Slider
              label="Fade-in đầu seg"
              hint="Giữ ngắn — TTS bắt đầu sạch sẵn"
              min={0} max={100} step={5}
              value={dubSettings.startFadeMs}
              onChange={(v) => setDubSettings({ startFadeMs: v })}
              format={(v) => `${v} ms`}
              isDefault={isDefault('startFadeMs', dubSettings.startFadeMs)}
              defaultValue={DUB_SETTINGS_DEFAULTS.startFadeMs}
              onResetDefault={() => setDubSettings({ startFadeMs: DUB_SETTINGS_DEFAULTS.startFadeMs })}
            />
          </section>

          {/* ─── P0: Speed slot-fit clamp ─────────────────── */}
          <section className="dub-settings-section">
            <h4>Speed slot-fit (nudge tốc độ TTS)</h4>
            <p className="dub-settings-section__desc">
              Trước khi gen, hệ thống nudge speed để model đọc tự nhiên gần với
              slot. Range hẹp = pace tự nhiên, range rộng = ép vừa slot nhiều hơn
              (đánh đổi pitch-shift).
            </p>
            <Slider
              label="Min factor"
              hint="Cho phép đọc chậm tối đa (vd 0.85 = -15%)"
              min={0.5} max={1.0} step={0.05}
              value={dubSettings.slotFactorMin}
              onChange={(v) => setDubSettings({ slotFactorMin: Math.min(v, dubSettings.slotFactorMax - 0.05) })}
              format={(v) => `${v.toFixed(2)}×`}
              isDefault={isDefault('slotFactorMin', dubSettings.slotFactorMin)}
              defaultValue={DUB_SETTINGS_DEFAULTS.slotFactorMin}
              onResetDefault={() => setDubSettings({ slotFactorMin: DUB_SETTINGS_DEFAULTS.slotFactorMin })}
            />
            <Slider
              label="Max factor"
              hint="Cho phép đọc nhanh tối đa (vd 1.25 = +25%)"
              min={1.0} max={2.0} step={0.05}
              value={dubSettings.slotFactorMax}
              onChange={(v) => setDubSettings({ slotFactorMax: Math.max(v, dubSettings.slotFactorMin + 0.05) })}
              format={(v) => `${v.toFixed(2)}×`}
              isDefault={isDefault('slotFactorMax', dubSettings.slotFactorMax)}
              defaultValue={DUB_SETTINGS_DEFAULTS.slotFactorMax}
              onResetDefault={() => setDubSettings({ slotFactorMax: DUB_SETTINGS_DEFAULTS.slotFactorMax })}
            />
          </section>

          {/* ─── P1: TTS quality knobs (share with Generate tab) ───── */}
          <section className="dub-settings-section dub-settings-section--full">
            <h4>TTS quality</h4>
            <p className="dub-settings-section__desc">
              Knobs chung với Generate tab — đổi sẽ ảnh hưởng cả hai.
            </p>

            <div className="dub-settings-section__grid">
            <Slider
              label="Global speed"
              hint="Multiplier nhân vào seg.speed (nếu chưa set per-seg)"
              min={0.5} max={2.0} step={0.05}
              value={speed}
              onChange={setSpeed}
              format={(v) => `${v.toFixed(2)}×`}
              isDefault={speed === 1.0}
              defaultValue={1.0}
              onResetDefault={() => setSpeed(1.0)}
            />
            <Slider
              label="Num steps"
              hint="Flow-matching steps. ↑ chất lượng, ↓ tốc độ (preview dùng 8)"
              min={4} max={32} step={1}
              value={steps}
              onChange={setSteps}
              format={(v) => `${v}`}
              isDefault={steps === 16}
              defaultValue={16}
              onResetDefault={() => setSteps(16)}
            />
            <Slider
              label="Guidance scale"
              hint="Bám prompt mạnh/yếu. ↑ trung thành, ↓ tự do"
              min={1.0} max={5.0} step={0.1}
              value={cfg}
              onChange={setCfg}
              format={(v) => v.toFixed(1)}
              isDefault={cfg === 2.0}
              defaultValue={2.0}
              onResetDefault={() => setCfg(2.0)}
            />
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({ label, hint, children, isDefault }) {
  return (
    <div className="dub-settings-row">
      <div className="dub-settings-row__label">
        <span>{label}</span>
        {!isDefault && <Badge tone="warn" size="xs">tuỳ chỉnh</Badge>}
      </div>
      {hint && <div className="dub-settings-row__hint">{hint}</div>}
      <div className="dub-settings-row__control">{children}</div>
    </div>
  );
}

function Slider({
  label, hint, min, max, step, value, onChange, format,
  isDefault, defaultValue, onResetDefault,
}) {
  return (
    <div className="dub-settings-row">
      <div className="dub-settings-row__label">
        <span>{label}</span>
        <span className="dub-settings-row__value">{format(value)}</span>
        {!isDefault && (
          <button
            type="button"
            className="dub-settings-row__reset"
            onClick={onResetDefault}
            title={`Reset về mặc định ${format(defaultValue)}`}
          >
            <RotateCcw size={10} />
          </button>
        )}
      </div>
      {hint && <div className="dub-settings-row__hint">{hint}</div>}
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="dub-settings-row__slider"
      />
    </div>
  );
}
