import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { remoteSlice } from './slice.ts';
import { remoteTab } from './RemoteView.tsx';
import { RemoteDot, RemoteMenuRow } from './RemoteMenu.tsx';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof remoteSlice> {}
}

export const remotePlugin = definePlugin({
  id: 'remote',
  slices: [remoteSlice],
  tabs: [remoteTab],
  slots: [{ slot: 'header.menu', order: 10, render: RemoteMenuRow }, { slot: 'header.badge', order: 10, render: RemoteDot }],
});
