import { enterRoot, readSavedTabs, serializeTabs, tabsKey } from '../tabs/slice.ts';
import { json, storage } from '../sdk/storage.ts';
import type { StartListening } from './store.ts';

/**
 * The core's persistence of UI state, whoever changed it (tab clicks, ×, restores): one listener per concern, each
 * comparing the state before the action with the state after it. The plugins persist their own state in their own
 * listeners, registered after these (see `Plugin.listeners`). Writes wait for the first known root and are keyed by it
 * (`tabs.root`, set by `enterRoot`); the root-change listener is registered first of all, so its restore is already in
 * place when the others look at the same action.
 */
export function persistListeners(start: StartListening, kinds: { has(kind: string): boolean }): void {
  let restoredRoot: string | null = null;

  // every root change (the first one, a switch to another folder, a switch back): `enterRoot`, carrying that root's
  // saved tabs (one action, so the media controller sees one tab change). They are read before the dispatch: the
  // restore's own change is persisted under the new root by the listeners below (the dispatch runs them nested). Each
  // plugin restores its own state in its own `enterRoot` listener.
  start({
    predicate: (_a, st) => !!st.feed.session?.root && st.feed.session.root !== restoredRoot,
    effect: (_a, api) => {
      const root = api.getState().feed.session?.root;
      if (!root || root === restoredRoot) return;
      const first = restoredRoot === null;
      restoredRoot = root;
      api.dispatch(enterRoot({ root, first, tabs: readSavedTabs(root, kinds) }));
    },
  });

  // before the root is known there is nothing to key by; the restore merges those tabs in later
  start({
    predicate: (_a, st, was) => st.tabs !== was.tabs,
    effect: (_a, api) => {
      const { tabs } = api.getState();
      if (tabs.root) storage.local(tabsKey(tabs.root), json(), null).set(serializeTabs(tabs));
    },
  });
}
