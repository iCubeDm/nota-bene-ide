import { definePlugin } from '@/sdk';
import { VoicePart } from './VoiceBubble.tsx';

export const voicePlugin = definePlugin({ id: 'voice', userParts: [{ id: 'voice', order: 10, render: VoicePart }] });
