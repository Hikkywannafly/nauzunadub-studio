import React, { useState, useCallback, useEffect } from 'react';
import { Loader, Upload } from 'lucide-react';
import { Mic2 } from 'lucide-react';
import { useAppStore } from '../store';
import { Segmented } from '../ui';
import { PRESETS } from '../utils/constants';
import toast from 'react-hot-toast';

export default function DubCastPanel({ speakerClones = {}, profiles = [], audioProfile, setAudioProfile }) {
  const dubSegments    = useAppStore(s => s.dubSegments);
  const setDubSegments = useAppStore(s => s.setDubSegments);

  const [castModeOverride, setCastModeOverride] = useState(null);
  const [uploadingSpeaker, setUploadingSpeaker] = useState(null);
  const [audioProfiles, setAudioProfiles] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const { listAudioProfiles } = await import('../api/audioProfiles');
        setAudioProfiles(await listAudioProfiles());
      } catch {
        setAudioProfiles([
          { id: 'cinematic', label: 'Cinematic (phim drama)', description: 'Giữ dynamic range' },
          { id: 'broadcast', label: 'Broadcast (vlog/postcast)', description: 'Đều như phát thanh' },
          { id: 'voiceover', label: 'Voiceover (narrator)', description: 'Phẳng, ổn định' },
          { id: 'natural',   label: 'Natural (raw)',         description: 'Không xử lý' },
        ]);
      }
    })();
  }, []);

  const uploadVoiceForSpeaker = useCallback((spk) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,video/*';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setUploadingSpeaker(spk);
      try {
        const { createProfile } = await import('../api/profiles');
        const formData = new FormData();
        const safeName = `${spk.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now().toString(36)}`;
        formData.append('name', safeName);
        formData.append('ref_audio', file);
        const newProfile = await createProfile(formData);
        setDubSegments(dubSegments.map(s => s.speaker_id === spk ? { ...s, profile_id: newProfile.id } : s));
        toast.success(`Đã gán giọng "${file.name}" cho ${spk}`);
      } catch (err) {
        toast.error(`Upload thất bại: ${err.message || err}`);
      } finally {
        setUploadingSpeaker(null);
      }
    };
    input.click();
  }, [dubSegments, setDubSegments]);

  const speakers  = [...new Set(dubSegments.map(s => s.speaker_id).filter(Boolean))];
  if (!speakers.length) return null;

  const autoIdFor = (spk) => `auto:${(spk || '').toLowerCase().replace(/\s+/g, '_')}`;
  const pidOf     = (spk) => dubSegments.find(s => s.speaker_id === spk)?.profile_id || '';
  const pids      = speakers.map(pidOf);

  const allClone    = pids.length > 0 && pids.every(p => p && p.startsWith('auto:'));
  const allEmpty    = pids.length > 0 && pids.every(p => !p);
  const firstPid    = pids[0] || '';
  const allNarrator = firstPid && !firstPid.startsWith('auto:') && pids.every(p => p === firstPid);
  const derivedMode = allClone ? 'clone' : allNarrator ? 'narrator' : allEmpty ? 'default' : 'custom';
  const castMode    = castModeOverride || derivedMode;

  const applyMode = (mode) => {
    if (mode === 'clone') {
      setDubSegments(dubSegments.map(s => {
        if (!s.speaker_id) return s;
        const aid = autoIdFor(s.speaker_id);
        return { ...s, profile_id: speakerClones[s.speaker_id] ? aid : '' };
      }));
      setCastModeOverride(null);
    } else if (mode === 'default') {
      setDubSegments(dubSegments.map(s => s.speaker_id ? { ...s, profile_id: '' } : s));
      setCastModeOverride(null);
    } else if (mode === 'narrator') {
      setCastModeOverride('narrator');
    }
  };

  const setNarratorVoice = (val) => {
    setDubSegments(dubSegments.map(s => s.speaker_id ? { ...s, profile_id: val } : s));
    setCastModeOverride(null);
  };

  return (
    <div className="dub-cast">
      <div className="dub-cast__row dub-cast__row--mode">
        <span
          className="dub-cast__kicker"
          title="Voice source for dubbed audio. Clone = keep each speaker's timbre from the original video. Narrator = one voice reads everything. Default = TTS engine's stock voice."
        >
          <Mic2 size={10} /> CAST
        </span>
        <Segmented
          size="sm"
          value={castMode === 'custom' ? undefined : castMode}
          onChange={applyMode}
          items={[
            { value: 'clone',    label: '🎤 Clone từ video', title: 'Giữ màu giọng từng speaker từ video gốc (zero-shot voice clone).' },
            { value: 'narrator', label: '🎙️ Narrator',      title: 'Một giọng đọc hết phim.' },
            { value: 'default',  label: '🔊 Default',        title: 'Giọng mặc định của engine TTS — không clone, không pick.' },
          ]}
        />
        {castMode === 'narrator' && (
          <select
            className="input-base dub-cast__select dub-cast__select--narrator"
            value={firstPid}
            onChange={e => setNarratorVoice(e.target.value)}
            title="Pick the one voice that reads every line"
          >
            <option value="" disabled>— Pick a voice —</option>
            {profiles.length > 0 && (
              <optgroup label="Clone Profiles">
                {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </optgroup>
            )}
            {PRESETS.length > 0 && (
              <optgroup label="Design Presets">
                {PRESETS.map(p => <option key={p.id} value={`preset:${p.id}`}>{p.name}</option>)}
              </optgroup>
            )}
          </select>
        )}
        {castMode === 'custom' && (
          <span className="dub-cast__badge" title="Per-speaker voices differ from a single mode. Use the row below to tweak.">Custom</span>
        )}
        <div
          className="dub-cast__audio-style"
          title={audioProfiles.find(a => a.id === audioProfile)?.description || 'Audio post-processing: compress + normalize phù hợp loại content.'}
        >
          <span className="dub-cast__label">Audio Style:</span>
          <select
            className="input-base dub-cast__audio-style-select"
            value={audioProfile}
            onChange={e => setAudioProfile(e.target.value)}
          >
            {audioProfiles.map(a => (
              <option key={a.id} value={a.id} title={a.description}>{a.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="dub-cast__row dub-cast__row--speakers">
        {speakers.map(spk => {
          const autoId     = autoIdFor(spk);
          const clone      = speakerClones[spk];
          const isUploading = uploadingSpeaker === spk;
          return (
            <div key={spk} className="dub-cast__pair">
              <span className="dub-cast__label">{spk}:</span>
              <select
                className="input-base dub-cast__select"
                value={pidOf(spk)}
                onChange={e => {
                  const val = e.target.value;
                  setDubSegments(dubSegments.map(s => s.speaker_id === spk ? { ...s, profile_id: val } : s));
                }}
              >
                {clone && (
                  <option value={autoId}>🎤 From video · {clone.duration.toFixed(1)}s</option>
                )}
                <option value="">Default (không clone)</option>
                {profiles.length > 0 && (
                  <optgroup label="Clone Profiles">
                    {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </optgroup>
                )}
                {PRESETS.length > 0 && (
                  <optgroup label="Design Presets">
                    {PRESETS.map(p => <option key={p.id} value={`preset:${p.id}`}>{p.name}</option>)}
                  </optgroup>
                )}
              </select>
              <button
                type="button"
                className="dub-cast__upload-btn"
                title="Upload audio sample 3-30s làm giọng cho speaker này"
                disabled={isUploading}
                onClick={() => uploadVoiceForSpeaker(spk)}
              >
                {isUploading ? <Loader size={11} className="spinner" /> : <Upload size={11} />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
