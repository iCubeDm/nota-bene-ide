import type { Middleware, Slice } from '@reduxjs/toolkit';
import type { RootState, StartListening } from '../store/store.ts';

/**
 * The plugins' part of the store's state. Empty here: each plugin's `plugin.ts` adds its slices by declaration merging
 * (`declare module '@/sdk' { interface PluginState extends WithSlice<typeof slice> {} }`), so `RootState` is fully typed
 * without the store importing any plugin.
 */
export interface PluginState {}

/**
 * A feature module, compiled into the bundle and listed in `web/src/plugins.ts` (issue 511). Order is behavior: the
 * core's part comes first, then each plugin's in `PLUGINS` order, a plugin's own in its declared order.
 */
export interface Plugin {
  id: string;
  /** injected into the store once, at its creation, under each slice's own name */
  slices?: Slice[];
  /** appended after the core's toast middleware and before its media middleware, which stays last */
  middleware?: Middleware[];
  /**
   * The plugin's listeners on the store's one listener middleware, one per concern (persist-style). The core's come
   * first: the root-change listener (it dispatches `enterRoot` with the core tabs' saved state), then the tabs' save.
   * A saving listener compares the state before and after the action, so it sees a restore an earlier one dispatched.
   */
  listeners?: (start: StartListening) => void;
  /** false while the plugin holds the page busy: the page's pause (`shell/pagePause.ts`) is the AND of these */
  pause?: (s: RootState, o: { draft: boolean }) => boolean;
}

export const definePlugin = (p: Plugin): Plugin => p;
