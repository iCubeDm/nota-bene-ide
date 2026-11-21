import { definePlugin } from '@/sdk';
import { VoicePart } from './VoiceBubble.tsx';
import { voiceSendListener } from './send.ts';
import { voiceSettings } from './DictationSettings.tsx';
import { dictationResource } from './dictation.ts';

export const voicePlugin = definePlugin({
  id: 'voice', listeners: voiceSendListener, userParts: [{ id: 'voice', order: 10, render: VoicePart }],
  settings: voiceSettings, resources: [dictationResource],
});
