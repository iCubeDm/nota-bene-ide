import type { FC, RefObject } from 'react';
import type { Voice, VoiceError } from '@nota-bene/shared';
import { definePlugin, type AppThunk } from '@/sdk';
import { VoicePart } from './VoiceBubble.tsx';
import { onVoiceRefused } from './inflight.ts';
import { sendVoice, voiceSendListener } from './send.ts';
import { voiceSettings } from './DictationSettings.tsx';
import { dictationResource } from './dictation.ts';
import { useVoiceRecorder, type RecState, type VoiceRecorder } from './useVoiceRecorder.ts';
import { RecordBar } from './RecordBar.tsx';
import { WhisperPrompt } from './WhisperPrompt.tsx';
import { ClipRow } from './ClipRow.tsx';
import { transcribeVoice } from './upload.ts';

declare module '@/sdk' {
  interface Services { voice: VoiceService }
}

/**
 * The voice messages as the composer and the comment popup use them (issue 545), provided by the voice plugin and read
 * with `useService('voice')`: the recorder, its bar, the Whisper set-up prompt, a comment's clip, and the sends.
 */
export interface VoiceService {
  /**
   * `onDone` gets the uploaded voice (and whether Send forced) and answers false when it could not use it: the
   * recording stays in the preview. `preview`: Stop goes to a preview; without it Stop uploads at once.
   */
  useRecorder(o: { onDone: (v: Voice, force: boolean) => boolean | void; notify: (msg: string) => void; preview: boolean }): VoiceRecorder;
  /** the field while recording; `clip`: a comment's recording (Stop adds the clip) */
  RecordBar: FC<{ state: Exclude<RecState, { phase: 'idle' }>; onCancel: () => void; onStop?: () => void; onSend: (force: boolean) => void; clip?: boolean; busy?: boolean; onEscape?: () => boolean }>;
  /** the mic without Whisper: the prompt to set it up, anchored to the mic */
  WhisperPrompt: FC<{ open: boolean; onOpenChange: (open: boolean) => void; anchor: RefObject<HTMLElement | null> }>;
  /** a comment's recording with its transcript; its player stops on delete */
  ClipRow: FC<{ voice: Voice; text?: string; error?: VoiceError; onRetry?: () => void; onDelete?: () => void }>;
  transcribe(id: string, ask: { lang: string; detect?: true }): Promise<{ text: string; lang?: string } | { error: VoiceError }>;
  /**
   * a recording as a message of its own; `force`: it interrupts the agent, `rides`: the pending comments go with it.
   * False when nothing was sent
   */
  send(voice: Voice, o?: { id?: string; force?: boolean; rides?: boolean }): AppThunk<boolean>;
  /** a refused voice send's recording, back to its host */
  onRefused(fn: (v: Voice) => void): () => void;
}

export const voicePlugin = definePlugin({
  id: 'voice', listeners: voiceSendListener, userParts: [{ id: 'voice', order: 10, render: VoicePart }],
  settings: voiceSettings, resources: [dictationResource],
  voice: { useRecorder: useVoiceRecorder, RecordBar, WhisperPrompt, ClipRow, transcribe: transcribeVoice, send: sendVoice, onRefused: onVoiceRefused },
});
