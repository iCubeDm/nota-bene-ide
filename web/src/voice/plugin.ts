import { definePlugin } from '@/sdk';
import { VoicePart } from './VoiceBubble.tsx';
import { voiceSendListener } from './send.ts';

export const voicePlugin = definePlugin({ id: 'voice', listeners: voiceSendListener, userParts: [{ id: 'voice', order: 10, render: VoicePart }] });
