import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { statsSlice } from './slice.ts';
import { CtxNudge } from './CtxNudge.tsx';
import { Meters } from './Meters.tsx';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof statsSlice> {}
}

export const statsPlugin = definePlugin({
  id: 'stats', slices: [statsSlice],
  slots: [{ slot: 'composer.status', order: 10, render: CtxNudge }, { slot: 'composer.end', order: 20, render: Meters }],
});
