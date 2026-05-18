import { useEffect, useState } from 'react';
import { Play, Trash2, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  listSpeakers,
  setSpeakerAssignment,
  clearSpeakerAssignment,
  previewVoice,
} from '../api/dubVoices';
import { listProfiles } from '../api/profiles';
import { listEngines } from '../api/engines';
import { useAppStore } from '../store';
import { apiUrl } from '../api/client';

/**
 * SpeakerVoiceMap — bảng map speaker → voice profile + engine + pitch/speed/volume.
 *
 * Props:
 *   jobId: string — current dub job id
 *   onChanged?: () => void — callback fired after any assignment change
 */
export default function SpeakerVoiceMap({ jobId, onChanged }) {
  const speakers = useAppStore((s) => s.speakersByJob[jobId] || []);
  const setSpeakers = useAppStore((s) => s.setSpeakers);
  const updateSpeaker = useAppStore((s) => s.updateSpeaker);
  const setLoading = useAppStore((s) => s.setVoiceLoading);
  const loading = useAppStore((s) => s.voiceLoading);
  const setError = useAppStore((s) => s.setVoiceError);

  const [profiles, setProfiles] = useState([]);
  const [engines, setEngines] = useState([]);
  const [previewing, setPreviewing] = useState(null);
  const [previewAudio, setPreviewAudio] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [spList, profList, engList] = await Promise.all([
          listSpeakers(jobId),
          listProfiles().catch(() => []),
          listEngines().catch(() => ({ tts: [] })),
        ]);
        if (cancelled) return;
        setSpeakers(jobId, spList);
        setProfiles(profList);
        setEngines((engList && engList.tts) || []);
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load speakers');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (jobId) load();
    return () => {
      cancelled = true;
    };
  }, [jobId, setSpeakers, setLoading, setError]);

  async function patchSpeaker(speakerId, patch) {
    try {
      updateSpeaker(jobId, speakerId, patch);
      await setSpeakerAssignment(jobId, speakerId, patch);
      onChanged?.();
    } catch (e) {
      toast.error(`Failed to save: ${e.message || e}`);
    }
  }

  async function handlePreview(speakerId) {
    setPreviewing(speakerId);
    try {
      const res = await previewVoice(jobId, speakerId);
      setPreviewAudio(apiUrl(res.preview_url));
    } catch (e) {
      toast.error(`Preview failed: ${e.message || e}`);
    } finally {
      setPreviewing(null);
    }
  }

  async function handleClear(speakerId) {
    if (!confirm(`Bỏ voice assignment cho ${speakerId}?`)) return;
    try {
      await clearSpeakerAssignment(jobId, speakerId);
      updateSpeaker(jobId, speakerId, {
        profile_id: null, engine: null, pitch: 0, speed: 1, volume: 1,
      });
      onChanged?.();
    } catch (e) {
      toast.error(`Clear failed: ${e.message || e}`);
    }
  }

  if (loading) return <div className="p-4 text-sm text-muted-foreground">Đang tải speakers…</div>;
  if (!speakers.length) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Chưa có speakers — chạy bước Transcribe trước.
      </div>
    );
  }

  return (
    <div className="speaker-voice-map space-y-3">
      <div className="text-sm text-muted-foreground">
        Gán giọng cho từng speaker. Nếu bỏ trống sẽ dùng engine + giọng mặc định lúc Generate.
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b">
            <th className="py-2 pr-2">Speaker</th>
            <th className="py-2 pr-2">Voice Profile</th>
            <th className="py-2 pr-2">TTS Engine</th>
            <th className="py-2 pr-2">Pitch</th>
            <th className="py-2 pr-2">Speed</th>
            <th className="py-2 pr-2">Volume</th>
            <th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {speakers.map((sp) => (
            <tr key={sp.speaker_id} className="border-b last:border-0 align-middle">
              <td className="py-2 pr-2">
                <div className="font-medium">{sp.speaker_id}</div>
                <div className="text-xs text-muted-foreground">
                  {sp.segment_count} đoạn · {sp.total_duration.toFixed(1)}s
                </div>
                <div className="text-xs text-muted-foreground italic truncate max-w-[260px]">
                  "{sp.sample_text}"
                </div>
              </td>
              <td className="py-2 pr-2">
                <select
                  className="border rounded px-2 py-1 bg-background"
                  value={sp.profile_id || ''}
                  onChange={(e) => patchSpeaker(sp.speaker_id, { profile_id: e.target.value || null })}
                >
                  <option value="">— chưa gán —</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} {p.language_code ? `(${p.language_code})` : ''}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-2 pr-2">
                <select
                  className="border rounded px-2 py-1 bg-background"
                  value={sp.engine || ''}
                  onChange={(e) => patchSpeaker(sp.speaker_id, { engine: e.target.value || null })}
                >
                  <option value="">Mặc định</option>
                  {engines
                    .filter((eng) => eng.available !== false)
                    .map((eng) => (
                      <option key={eng.id} value={eng.id}>
                        {eng.display_name || eng.id}
                      </option>
                    ))}
                </select>
              </td>
              <td className="py-2 pr-2">
                <input
                  type="number"
                  step="0.5"
                  min="-12"
                  max="12"
                  className="border rounded px-2 py-1 w-16 bg-background"
                  value={sp.pitch}
                  onChange={(e) => patchSpeaker(sp.speaker_id, { pitch: parseFloat(e.target.value) || 0 })}
                />
              </td>
              <td className="py-2 pr-2">
                <input
                  type="number"
                  step="0.05"
                  min="0.5"
                  max="2"
                  className="border rounded px-2 py-1 w-16 bg-background"
                  value={sp.speed}
                  onChange={(e) => patchSpeaker(sp.speaker_id, { speed: parseFloat(e.target.value) || 1 })}
                />
              </td>
              <td className="py-2 pr-2">
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  className="border rounded px-2 py-1 w-16 bg-background"
                  value={sp.volume}
                  onChange={(e) => patchSpeaker(sp.speaker_id, { volume: parseFloat(e.target.value) || 1 })}
                />
              </td>
              <td className="py-2">
                <div className="flex items-center gap-2">
                  <button
                    title="Preview giọng"
                    disabled={!sp.profile_id || previewing === sp.speaker_id}
                    onClick={() => handlePreview(sp.speaker_id)}
                    className="p-1 rounded hover:bg-muted disabled:opacity-50"
                  >
                    {previewing === sp.speaker_id
                      ? <RefreshCw size={16} className="animate-spin" />
                      : <Play size={16} />}
                  </button>
                  <button
                    title="Xoá assignment"
                    onClick={() => handleClear(sp.speaker_id)}
                    className="p-1 rounded hover:bg-muted text-red-500"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {previewAudio && (
        <div className="mt-3">
          <audio key={previewAudio} controls autoPlay src={previewAudio} className="w-full" />
        </div>
      )}
    </div>
  );
}
