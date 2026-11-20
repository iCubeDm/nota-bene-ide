import type { Slice } from '@reduxjs/toolkit';

/**
 * The plugins' part of the store's state. Empty here: each plugin's `plugin.ts` adds its slices by declaration merging
 * (`declare module '@/sdk' { interface PluginState extends WithSlice<typeof slice> {} }`), so `RootState` is fully typed
 * without the store importing any plugin.
 */
export interface PluginState {}

/** A feature module, compiled into the bundle and listed in `web/src/plugins.ts` (issue 511). */
export interface Plugin {
  id: string;
  /** injected into the store once, at its creation, under each slice's own name */
  slices?: Slice[];
}

export const definePlugin = (p: Plugin): Plugin => p;
