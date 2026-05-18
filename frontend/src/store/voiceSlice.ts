/**
 * Voice Settings slice — speaker→voice assignments per dub job.
 *
 * Loaded lazily when the user opens the Voice Settings page. Mutations
 * write through to the backend immediately so a refresh always reflects
 * server truth.
 */
import type { StateCreator } from 'zustand';
import type { SpeakerInfo, SpeakerAssignment } from '../api/dubVoices';

export interface VoiceSlice {
  // Map<jobId, SpeakerInfo[]>
  speakersByJob: Record<string, SpeakerInfo[]>;
  voiceLoading: boolean;
  voiceError: string | null;

  setSpeakers: (jobId: string, list: SpeakerInfo[]) => void;
  updateSpeaker: (jobId: string, speakerId: string, patch: Partial<SpeakerInfo>) => void;
  setVoiceLoading: (loading: boolean) => void;
  setVoiceError: (err: string | null) => void;
  resetVoiceState: (jobId?: string) => void;
}

export const createVoiceSlice: StateCreator<VoiceSlice> = (set) => ({
  speakersByJob: {},
  voiceLoading: false,
  voiceError: null,

  setSpeakers: (jobId, list) =>
    set((s) => ({ speakersByJob: { ...s.speakersByJob, [jobId]: list } })),

  updateSpeaker: (jobId, speakerId, patch) =>
    set((s) => {
      const current = s.speakersByJob[jobId] || [];
      const next = current.map((sp) =>
        sp.speaker_id === speakerId ? { ...sp, ...patch } : sp,
      );
      return { speakersByJob: { ...s.speakersByJob, [jobId]: next } };
    }),

  setVoiceLoading: (loading) => set({ voiceLoading: loading }),
  setVoiceError: (err) => set({ voiceError: err }),

  resetVoiceState: (jobId) =>
    set((s) => {
      if (!jobId) return { speakersByJob: {}, voiceError: null };
      const { [jobId]: _, ...rest } = s.speakersByJob;
      return { speakersByJob: rest, voiceError: null };
    }),
});

export type { SpeakerInfo, SpeakerAssignment };
