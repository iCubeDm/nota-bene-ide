import type { Command } from '@/sdk';
import { recentModal } from './recent.ts';
import { revealFile, setTreeOpen } from './treeSlice.ts';
import { wrapLines } from './wrap.ts';

export const filesCommands: Command[] = [
  // Alt+E, not Cmd/Ctrl+E: Claude in Chrome takes ⌘E (the user, 2026-10-27). In a field too, also on a Mac: there
  // Option+E is the ´ dead key, which the binding consumes (recent files from the composer is the common case).
  // Over a modal too: it toggles its own dialog
  { id: 'hk_recent', codes: ['KeyE'], mods: { alt: true }, inFields: true, inModal: () => true, order: 60,
    run: () => (recentModal.get() ? recentModal.close() : recentModal.open()) },
  { id: 'hk_files', codes: ['KeyF'], mods: { mod: true, shift: true }, inFields: true, order: 110,
    run: ({ store }) => void store.dispatch(setTreeOpen(!store.getState().tree.open)) },
  { id: 'hk_wrap', codes: ['KeyZ'], mods: { alt: true }, inFields: 'notMac', order: 150, run: () => wrapLines.toggle() },
  { id: 'hk_reveal', codes: ['F1'], mods: { alt: true }, inFields: true, order: 190,
    run: ({ store }) => {
      const st = store.getState();
      const tab = st.tabs.open.find((t) => t.id === st.tabs.active);
      if (tab?.kind === 'file') store.dispatch(revealFile(tab.path, tab.src));
    } },
];
