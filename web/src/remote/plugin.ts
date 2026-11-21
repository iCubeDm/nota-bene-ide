import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { remoteSlice } from './slice.ts';
import { remoteTab } from './RemoteView.tsx';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof remoteSlice> {}
}

export const remotePlugin = definePlugin({ id: 'remote', slices: [remoteSlice], tabs: [remoteTab] });
