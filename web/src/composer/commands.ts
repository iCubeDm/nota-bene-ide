import { isMac, type Command } from '@/sdk';
import { promptHistoryModal } from './historyModal.ts';

/** what Alt+R dispatches on the document; the composer listens (the keymap has the store but not the composer's recorder). `detail.force`: Cmd/Ctrl was held too */
export const VOICE_KEY = 'nb:voice-key';

const focusComposer = () => (document.getElementById('composer-input') as HTMLTextAreaElement | null)?.focus();

export const composerCommands: Command[] = [
  // Alt+H, in a field too (also on a Mac, where Option+H types ˙): the prompt history list of the composer. No clash: H
  // was free. Over its own modal list too, to close it
  { id: 'hk_promptHistory', codes: ['KeyH'], mods: { alt: true }, inFields: true, inModal: () => promptHistoryModal.get(), order: 80,
    run: () => (promptHistoryModal.get() ? promptHistoryModal.close() : promptHistoryModal.open()) },
  // Alt+↑/↓ (Option on a Mac): older / newer prompt in the composer, whatever the draft. Only the composer's own key handler
  // walks; the keymap must not take the key elsewhere (native caret and scroll moves), so these are for the help list
  { id: 'hk_promptOlder', codes: ['ArrowUp'], mods: { alt: true }, inFields: true, helpOnly: true, order: 90, run: () => {} },
  { id: 'hk_promptNewer', codes: ['ArrowDown'], mods: { alt: true }, inFields: true, helpOnly: true, order: 100, run: () => {} },
  // Alt+R, in a field too (also on a Mac, where Option+R types ®): starts a voice message in the composer, or sends the one being recorded
  { id: 'hk_voice', codes: ['KeyR'], mods: { alt: true }, inFields: true, anyMod: true, order: 140,
    run: ({ e }) => void document.dispatchEvent(new CustomEvent(VOICE_KEY, { detail: { force: isMac() ? e.metaKey : e.ctrlKey } })) },
  { id: 'hk_composer', codes: ['Slash', 'Escape'], mods: {}, inFields: false, order: 200,
    run: ({ e }) => {
      // Esc only on empty space: not inside a dialog, menu or other widget that may want it
      if (e.code === 'Escape' && (e.target as HTMLElement | null)?.closest?.('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      focusComposer();
    } },
];
