import { useEffect } from 'react';
import SpeakerVoiceMap from '../components/SpeakerVoiceMap';
import { useAppStore } from '../store';

/**
 * VoiceSettings — page tách giữa Translate và Generate.
 * Cho user gán giọng từng speaker trước khi chạy TTS.
 */
export default function VoiceSettings({ jobId, onContinue, onBack }) {
  const error = useAppStore((s) => s.voiceError);
  const reset = useAppStore((s) => s.resetVoiceState);

  useEffect(() => () => reset(jobId), [jobId, reset]);

  if (!jobId) {
    return (
      <div className="voice-settings-page p-6">
        <h2 className="text-xl font-semibold mb-2">Voice Settings</h2>
        <p className="text-sm text-muted-foreground">Chưa có dub job đang mở.</p>
      </div>
    );
  }

  return (
    <div className="voice-settings-page p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">Voice Settings</h2>
          <p className="text-sm text-muted-foreground">
            Chọn giọng + engine cho từng speaker trước khi sinh audio.
          </p>
        </div>
        <div className="flex gap-2">
          {onBack && (
            <button
              onClick={onBack}
              className="px-3 py-1.5 rounded border hover:bg-muted text-sm"
            >
              ← Quay lại Translate
            </button>
          )}
          {onContinue && (
            <button
              onClick={onContinue}
              className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm hover:opacity-90"
            >
              Generate →
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="p-3 mb-3 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      <SpeakerVoiceMap jobId={jobId} />

      <div className="mt-6 text-xs text-muted-foreground">
        Mẹo: bấm <strong>Preview</strong> để nghe thử 1 câu với cấu hình hiện tại. Sau khi Generate
        xong, bạn vẫn có thể quay lại đây đổi giọng riêng từng đoạn từ Segment List.
      </div>
    </div>
  );
}
