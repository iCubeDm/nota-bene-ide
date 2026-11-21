import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { controlsListeners, controlsSlice } from './slice.ts';
import { chatTab } from './chatTab.tsx';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof controlsSlice> {}
}

export const controlsPlugin = definePlugin({ id: 'controls', slices: [controlsSlice], listeners: controlsListeners, tabs: [chatTab] });
