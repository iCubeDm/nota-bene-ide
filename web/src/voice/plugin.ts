import { definePlugin } from '@/sdk';
import { VoicePart } from './VoiceBubble.tsx';
import { onVoiceRefused } from './inflight.ts';
import { sendVoice, voiceSendListener } from './send.ts';
import { voiceSettings } from './DictationSettings.tsx';
import { dictationResource } from './dictation.ts';
import { useVoiceRecorder } from './useVoiceRecorder.ts';
import { RecordBar } from './RecordBar.tsx';
import { WhisperPrompt } from './WhisperPrompt.tsx';
import { ClipRow } from './ClipRow.tsx';
import { transcribeVoice } from './upload.ts';

export const voicePlugin = definePlugin({
  id: 'voice', listeners: voiceSendListener, userParts: [{ id: 'voice', order: 10, render: VoicePart }],
  settings: voiceSettings, resources: [dictationResource],
  voice: { useRecorder: useVoiceRecorder, RecordBar, WhisperPrompt, ClipRow, transcribe: transcribeVoice, send: sendVoice, onRefused: onVoiceRefused },
});
