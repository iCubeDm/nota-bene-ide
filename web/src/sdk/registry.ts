import type { FC, Ref } from 'react';
import type { I18nKey, t } from '../i18n/index.ts';
import type { ru } from '../i18n/ru.ts';
import type { AppStore, RootState } from '../store/store.ts';
import { CORE_COMMANDS } from '../shell/keymap.ts';
import type { Tab, TabKinds } from '../tabs/slice.ts';
import type { Plugin } from './plugin.ts';

/**
 * How a tab of one kind looks and what it shows (issue 511): the tab host (`tabs/`) renders every tab through these.
 * Its data, id and saved form are the kind's entry in `TabKinds`, made by the tabs' own actions.
 */
export interface TabView<K extends keyof TabKinds = keyof TabKinds> {
  kind: K;
  /** its name, in the strip and in the tabs menu alike */
  label(tab: TabKinds[K], tr: typeof t, s: RootState): string;
  /** default: the kind's icon in `ICONS` */
  Icon?: FC<{ tab: TabKinds[K] }>;
  /** after the name in the strip (a source chip, a badge, a picker) */
  Extra?: FC<{ tab: TabKinds[K] }>;
  /** the muted text at the right of its row in the tabs menu */
  detail?(tab: TabKinds[K], tr: typeof t): string;
  /** its name can be edited from its menu: `when` it can, the menu row, the input shown in place of the name */
  edit?: { when(s: RootState): boolean; label: I18nKey; Input: FC<{ ref: Ref<HTMLInputElement>; tab: TabKinds[K]; done(back: boolean): void }> };
  /** its pane, mounted while the tab is open (hidden when it is not `active`); none for the chat, which the frame renders */
  render?: FC<{ tab: TabKinds[K]; active: boolean; rootGen: number }>;
}

/** A view of some kind, as a plugin lists it. */
export type AnyTabView = { [K in keyof TabKinds]: TabView<K> }[keyof TabKinds];

/**
 * The places in the frame a plugin fills (issue 511), each named by where it sits: the header's project title, its
 * part over the middle column (left edge on the first tab's), its right end, the settings menu (between the scale and
 * the Usage row) and the settings button's badge; the tool strips; the panels left and right of the middle column; the
 * chat pane; over the panes; the footer; the overlays after the frame.
 */
export type SlotName = 'header.title' | 'header.center' | 'header.end' | 'header.menu' | 'header.badge' | 'strip.left' | 'strip.right'
  | 'panel.left' | 'panel.right' | 'chat' | 'panes' | 'footer' | 'overlay';

/** A plugin's part of the frame: rendered at `slot` by ascending `order`, with the frame's own parts (see `Slots`). */
export interface Slot {
  slot: SlotName;
  order: number;
  render: FC;
}

/** A command's id: the i18n key of its line in the ? help. */
export type KeyId = keyof typeof ru & `hk_${string}`;
export type Mods = { mod?: boolean; alt?: boolean; shift?: boolean };

/** A global hotkey (issue 511): the keymap (`shell/keymap.ts`) matches the registered ones under its rules. */
export interface Command {
  id: KeyId;
  /** `code`s that trigger it (`Digit1`…). */
  codes: string[];
  mods: Mods;
  /** also when focus is in a text field; 'notMac': only off a Mac (Option+key types a character there) */
  inFields: boolean | 'notMac';
  /** also while a modal dialog is open, when this says so (a key that toggles its own dialog) */
  inModal?: () => boolean;
  /** also with Cmd (Mac) / Ctrl held, which `run` reads from the event: Alt+R and Ctrl+Alt+R are one binding */
  anyMod?: boolean;
  /** listed in the help only: the key is handled elsewhere (the composer), the keymap never matches or consumes it */
  helpOnly?: boolean;
  /** its place in the ? help, which is also the order keys are matched in */
  order: number;
  run: (c: { store: AppStore; e: KeyboardEvent }) => void;
}

/** What the plugins contribute, built once per store from its plugins and frozen. */
export interface Registry {
  tabs: ReadonlyMap<string, AnyTabView>;
  /** each slot's contributions by ascending order */
  slots: ReadonlyMap<SlotName, readonly Slot[]>;
  /** the core's and the plugins' hotkeys by ascending order */
  commands: readonly Command[];
}

/**
 * Each kind once: a kind two plugins claim is a build error, as a slice name taken twice is. So is one order taken
 * twice in a slot: the frame's order is never left to the order of `PLUGINS`. Commands alike: one id, one order each,
 * the core's (`CORE_COMMANDS`) among them.
 */
export function buildRegistry(plugins: readonly Plugin[]): Registry {
  const tabs = new Map<string, AnyTabView>();
  for (const v of plugins.flatMap((p) => p.tabs ?? [])) {
    if (tabs.has(v.kind)) throw new Error(`registry: the tab kind "${v.kind}" is declared twice`);
    tabs.set(v.kind, v);
  }
  const slots = new Map<SlotName, Slot[]>();
  for (const s of plugins.flatMap((p) => p.slots ?? [])) {
    const list = slots.get(s.slot) ?? [];
    if (list.some((x) => x.order === s.order)) throw new Error(`registry: the slot "${s.slot}" has two parts at order ${s.order}`);
    slots.set(s.slot, [...list, s].sort((a, b) => a.order - b.order));
  }
  for (const list of slots.values()) Object.freeze(list);
  const commands: Command[] = [];
  for (const c of [...CORE_COMMANDS, ...plugins.flatMap((p) => p.commands ?? [])]) {
    if (commands.some((x) => x.id === c.id)) throw new Error(`registry: the command "${c.id}" is declared twice`);
    if (commands.some((x) => x.order === c.order)) throw new Error(`registry: two commands at order ${c.order}`);
    commands.push(c);
  }
  return Object.freeze({ tabs, slots, commands: Object.freeze(commands.sort((a, b) => a.order - b.order)) });
}

/** The view of this tab's kind (the one place its type is narrowed to the tab's). */
export const tabView = <T extends Tab>(r: Registry, tab: T): TabView<T['kind']> | undefined =>
  r.tabs.get(tab.kind) as TabView<T['kind']> | undefined;

/** A tab's name, in the strip and its menu alike (issue 469); a kind no plugin shows is named by its kind. */
export const tabLabel = (r: Registry, tab: Tab, tr: typeof t, s: RootState): string => tabView(r, tab)?.label(tab, tr, s) ?? tab.kind;
