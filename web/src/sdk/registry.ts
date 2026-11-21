import type { FC, Ref } from 'react';
import type { I18nKey, t } from '../i18n/index.ts';
import type { RootState } from '../store/store.ts';
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

/** What the plugins contribute, built once per store from its plugins and frozen. */
export interface Registry {
  tabs: ReadonlyMap<string, AnyTabView>;
}

/** Each kind once: a kind two plugins claim is a build error, as a slice name taken twice is. */
export function buildRegistry(plugins: readonly Plugin[]): Registry {
  const tabs = new Map<string, AnyTabView>();
  for (const v of plugins.flatMap((p) => p.tabs ?? [])) {
    if (tabs.has(v.kind)) throw new Error(`registry: the tab kind "${v.kind}" is declared twice`);
    tabs.set(v.kind, v);
  }
  return Object.freeze({ tabs });
}

/** The view of this tab's kind (the one place its type is narrowed to the tab's). */
export const tabView = <T extends Tab>(r: Registry, tab: T): TabView<T['kind']> | undefined =>
  r.tabs.get(tab.kind) as TabView<T['kind']> | undefined;

/** A tab's name, in the strip and its menu alike (issue 469); a kind no plugin shows is named by its kind. */
export const tabLabel = (r: Registry, tab: Tab, tr: typeof t, s: RootState): string => tabView(r, tab)?.label(tab, tr, s) ?? tab.kind;
