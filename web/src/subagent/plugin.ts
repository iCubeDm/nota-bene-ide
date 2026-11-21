import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { subagentsSlice } from './slice.ts';
import { agentTab } from './AgentView.tsx';
import { agentCall } from './AgentCard.tsx';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof subagentsSlice> {}
}

export const subagentPlugin = definePlugin({ id: 'subagent', slices: [subagentsSlice], tabs: [agentTab], tools: [agentCall] });
