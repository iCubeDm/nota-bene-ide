import { registry, selectConn, type AppStore } from '@/core/store/store.ts';
import type { Command, KeyId } from '@/sdk/registry.ts';
import { activate, closeTab, reopenClosed } from '@/core/tabs/slice.ts';
import { editable } from '@/core/lib/editable.ts';
import { t } from '@/core/i18n/index.ts';
import { uiScale } from './uiScale.ts';
import { percent } from '@/core/lib/format.ts';
import { toast } from './toast.ts';

/**
 * The app's global hotkeys (M6-14, R-M6-5): the ONE document listener for them, over the store's registered commands
 * (issue 511: each plugin contributes its own; the tabs' and the scale's are the core's, below). Chrome keeps
 * Cmd/Ctrl+W/T/1-9 and Ctrl+Tab, so tabs go on Alt. Matching is by `code` (Alt on a Mac turns `key` into ∑, †…).
 *
 * Rules:
 * - it listens in the bubble phase and skips an event something already handled (`defaultPrevented`): popups, pickers
 *   and dialogs see their keys first (the Esc protocol);
 * - in a text field (input, textarea, any contenteditable) the Cmd/Ctrl bindings and Alt+F1 work. Alt+letter/digit
 *   work there only off a Mac: on a Mac, Option+key types characters (German, French, Nordic layouts type [ ] { } | that
 *   way), so in a field they type. Alt+←/→ (a field's word jump) and the plain keys (`/`, Esc) never fire in a field;
 * - while a modal dialog is open, only a command whose `inModal` says so runs (Alt+E toggles its own dialog, Alt+H
 *   closes its own list): the tabs behind the overlay stay put;
 * - `/` is matched by the character typed (`key`), so it follows the keyboard layout; the rest by `code`;
 * - nothing runs while an IME composes.
 */
export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** The Cmd/Ctrl modifier as the platform writes it before a key: `⌘` (`⌘Enter`) or `Ctrl+` (`Ctrl+Enter`). */
export const modKey = (): string => (isMac() ? '⌘' : 'Ctrl+');

const tabAt = (store: AppStore, i: number) => {
  const { open } = store.getState().tabs;
  return open[Math.max(0, Math.min(open.length - 1, i))]?.id;
};
const step = (store: AppStore, by: number) => {
  const { open, active } = store.getState().tabs;
  const i = open.findIndex((t) => t.id === active);
  return open[(i + by + open.length) % open.length]?.id;
};
/** a key changed the scale: say where it is now (there is no other sign of the step on screen) */
const scaled = (v: number) => toast(t('defScale'), percent(v));

export const CORE_COMMANDS: readonly Command[] = [
  { id: 'hk_closeTab', codes: ['KeyW'], mods: { alt: true }, inFields: 'notMac', order: 10,
    run: ({ store }) => { const { active } = store.getState().tabs; if (active !== 'chat') store.dispatch(closeTab(active)); } },
  { id: 'hk_reopenTab', codes: ['KeyT'], mods: { alt: true, shift: true }, inFields: 'notMac', order: 20, run: ({ store }) => void store.dispatch(reopenClosed()) },
  { id: 'hk_prevTab', codes: ['ArrowLeft'], mods: { alt: true }, inFields: false, order: 30, run: ({ store }) => { const id = step(store, -1); if (id) store.dispatch(activate(id)); } },
  { id: 'hk_nextTab', codes: ['ArrowRight'], mods: { alt: true }, inFields: false, order: 40, run: ({ store }) => { const id = step(store, 1); if (id) store.dispatch(activate(id)); } },
  // 1 = the chat … 8 = the eighth tab; 9 = the last one (as in Chrome)
  { id: 'hk_tabN', codes: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'], mods: { alt: true }, inFields: 'notMac', order: 50,
    run: ({ store, e }) => {
      const n = Number(e.code.slice(5));
      const id = n === 9 ? tabAt(store, Infinity) : store.getState().tabs.open[n - 1]?.id;
      if (id) store.dispatch(activate(id));
    } },
  // Alt, not Cmd/Ctrl: the browser's own zoom keeps Cmd/Ctrl +/−/0. Off a Mac in a field too (Option+− types – on a Mac)
  { id: 'hk_scaleUp', codes: ['Equal', 'NumpadAdd'], mods: { alt: true }, inFields: 'notMac', order: 160, run: () => scaled(uiScale.step(1)) },
  { id: 'hk_scaleDown', codes: ['Minus', 'NumpadSubtract'], mods: { alt: true }, inFields: 'notMac', order: 170, run: () => scaled(uiScale.step(-1)) },
  { id: 'hk_scaleReset', codes: ['Digit0', 'Numpad0'], mods: { alt: true }, inFields: 'notMac', order: 180, run: () => { uiScale.choose(1); scaled(1); } },
];

const matches = (b: Command, e: KeyboardEvent): boolean => {
  if (b.helpOnly) return false;
  // `/` by the character (a Russian PC layout types it with Shift+7; the US Slash key types "." there)
  const hit = b.codes.includes(e.code) && e.code !== 'Slash' || (b.codes.includes('Slash') && e.key === '/');
  if (!hit) return false;
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  const other = isMac() ? e.ctrlKey : e.metaKey;
  // a plain `/` may need Shift on the layout: the plain keys ignore Shift
  const shiftOk = b.mods.mod || b.mods.alt ? e.shiftKey === !!b.mods.shift : true;
  // AltGr reports Ctrl+Alt off a Mac: never one of ours
  return (b.anyMod || mod === !!b.mods.mod) && e.altKey === !!b.mods.alt && shiftOk && !other;
};
const inField = (b: Command) => b.inFields === true || (b.inFields === 'notMac' && !isMac());
// Radix sets no aria-modal (and a popover is role=dialog too): our modals carry data-nb-modal
const modalOpen = () => !!document.querySelector('[data-nb-modal]');

/** Installs the one listener; returns its removal. */
export function installKeymap(store: AppStore): () => void {
  const onKey = (e: KeyboardEvent) => {
    // a held key repeats only the tab stepping
    if (e.defaultPrevented || e.isComposing || (e.repeat && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight')) return;
    // the overlay of a stopped window makes the DOM inert, the document hotkeys must not reach under it either
    const conn = selectConn(store.getState());
    if (conn === 'stopped') return;
    const b = registry(store).commands.find((x) => matches(x, e));
    if (!b || (!inField(b) && editable(e.target))) return;
    if (!b.inModal?.(store.getState()) && modalOpen()) return;
    // Esc is not consumed here: a widget under it may still close on it
    if (e.code !== 'Escape') e.preventDefault();
    b.run({ store, e });
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}

/** A command's keys by its id, as the help shows them (`⌥T`); '' for none among `commands` (the store's: `useRegistry().commands`). */
export function keysFor(commands: readonly Command[], id: KeyId): string {
  const b = commands.find((x) => x.id === id);
  return b ? keysLabel(b) : '';
}

/** A control's label with its shortcut, for its tooltip: `Files (⌘⇧F)`. */
export function withKey(commands: readonly Command[], label: string, id: KeyId): string {
  const keys = keysFor(commands, id);
  return keys ? withKeys(label, keys) : label;
}

/** The same for a view's own keys (not registered commands: they act only where the view has them, as a player's): `Play (Space, K)`. */
export const withKeys = (label: string, keys: string): string => `${label} (${keys})`;

/** The keys of a binding as the platform shows them, for the help. */
export function keysLabel(b: Command): string {
  const mac = isMac();
  const parts: string[] = [];
  if (b.mods.mod) parts.push(modKey());
  if (b.mods.alt) parts.push(mac ? '⌥' : 'Alt+');
  if (b.mods.shift) parts.push(mac ? '⇧' : 'Shift+');
  const key = (c: string) => ({ ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Slash: '/', Escape: 'Esc', Equal: '=', Minus: '−', BracketLeft: '[', BracketRight: ']' } as Record<string, string>)[c] ?? c.replace(/^(Key|Digit)/, '');
  // the numpad twins are not listed: the help names a key once
  const keys = b.id === 'hk_tabN' ? '1…9' : b.codes.filter((c) => !c.startsWith('Numpad')).map(key).join(', ');
  return parts.join('') + keys;
}
