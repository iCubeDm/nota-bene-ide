import type { FC, MutableRefObject, Ref, SyntheticEvent } from 'react';
import type { Anchor, Comment, TextAnchor } from '@nota-bene/shared';
import type { I18nKey, t } from '../i18n/index.ts';
import type { ru } from '../i18n/ru.ts';
import type { AppStore, AppThunk, RootState } from '../store/store.ts';
import type { FeedItem } from '../store/feed.ts';
import type { FileKind } from '../refs/kinds.ts';
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

type ItemOf<K extends FeedItem['kind']> = Extract<FeedItem, { kind: K }>;
/** The kinds of feed items drawn through `feed`: all but actions, whose runs the feed draws itself (see `ToolRenderer`). */
export type FeedKind = Exclude<FeedItem['kind'], 'tool'>;
/** A send the server holds (issue 499), behind a pending restart or a compaction. */
export type Held = 'restart' | 'compact';

/** How the feed (`feed/Feed.tsx`) draws its items of one kind (issue 511); a kind is drawn by one plugin only. */
export interface FeedRenderer<K extends FeedKind = FeedKind> {
  kind: K;
  /** `held`: a user message the server holds, drawn after the feed */
  render: FC<{ item: ItemOf<K>; held?: Held }>;
}
/** A renderer of some kind, as a plugin lists it. */
export type AnyFeedRenderer = { [K in FeedKind]: FeedRenderer<K> }[FeedKind];

export type ToolItem = ItemOf<'tool'>;
/**
 * The head of the actions a plugin draws itself (a subagent's call is a card): the feed keeps the line's fold state, its
 * comment count and the commentable panel of input and output under the head. The first match among the plugins wins.
 */
export interface ToolRenderer {
  match(it: ToolItem): boolean;
  /**
   * `open`: the panel below is shown, `onToggle` folds it; `panelId` is its element's id; `comments`: on the action;
   * `busy`: the conversation it is in still works (the chat's, or a subagent's in its tab)
   */
  render: FC<{ item: ToolItem; open: boolean; panelId: string; comments: number; busy: boolean; onToggle(): void }>;
}

/** A part of a user message's body under its header line (a recording, the text, the images, the comments it carried), by ascending order. */
export interface UserPart {
  id: string;
  order: number;
  render: FC<{ item: ItemOf<'user'> }>;
}

/**
 * How a file tab shows a file of some kind (issue 511): the file tab (`files/FileView.tsx`) keeps the header, the load
 * and the text, which is every file no view matches and the ‹Source› of a text view. The first match by ascending order
 * shows the file. A view takes its own "jump to source" (`selectJump`, then `clearJump`) once the comment is on screen.
 */
interface FileViewBase {
  id: string;
  order: number;
  match(path: string, kind: FileKind): boolean;
}

/** Where a text view puts its own controls in the tab's header: before and after the ‹View | Source› switch. */
export type FileBar = { before: HTMLElement | null; after: HTMLElement | null };

/** A rendering of a text file (a page, an edit's timeline): the tab loads the text and offers ‹Source› beside it. */
export interface TextFileView extends FileViewBase {
  media?: false;
  /** the switch's labels: this view's button and the group's name */
  label: I18nKey;
  tip: I18nKey;
  /** it saves the file as it edits: back to ‹Source›, the text is read again */
  writes?: boolean;
  /** this comment is the view's to show: the tab shows the view for it, and the text for any other */
  jump?(c: Comment): boolean;
  render: FC<{ path: string; src: string; fileRef: string | undefined; tabId: string; active: boolean; text: string; bar: FileBar }>;
}

/** The media a file tab loaded for its view: no text is fetched. */
export interface MediaLoad {
  /** what the element shows; `head`: where its version is asked (a temp image shows a blob of it) */
  url: string;
  head: string;
  failed: boolean;
  /** the source (a worktree, a branch) is gone */
  srcGone: boolean;
  note?: string;
  onError(): void;
  onMeta(e: SyntheticEvent<HTMLMediaElement>): void;
  /** the playing element, which a reload reads its time from */
  el: MutableRefObject<HTMLMediaElement | null>;
  /** where a reload resumes; a jump to a time clears it */
  resumeAt: MutableRefObject<number>;
}

/** A file that is not text (an image, a video, a sound). */
export interface MediaFileView extends FileViewBase {
  media: true;
  /** while true for the tab, a reload waits (a drawing belongs to the frame on screen) */
  holds?(s: RootState, tabId: string): boolean;
  render: FC<{ kind: FileKind; path: string; src: string; fileRef: string | undefined; tabId: string; active: boolean; media: MediaLoad }>;
}

export type FileView = TextFileView | MediaFileView;

/** The kinds of anchor a plugin shows; a text anchor, which has no kind, is the comments' own. */
export type AnchorKind = Exclude<Anchor, TextAnchor>['kind'];

/**
 * How a comment on one kind of anchor shows in the UI (issue 511). A kind without one, or without a part, has the
 * comments' own: the core's `anchorLine` on its card, its source opened, its quote looked for in its file's text. What
 * the agent reads of a comment stays core (`anchors/quote.ts`): the batch is a contract the phone mirrors.
 */
export interface AnchorView {
  kind: AnchorKind;
  /** its place on the comment's card, in place of the line; `jump` shows the place (none in a popover) */
  Card?: FC<{ comment: Comment; jump?: () => void }>;
  /** shows the place, in place of opening the comment's source */
  reveal?(c: Comment): AppThunk;
  /** false: never orphaned (a mark on a picture, a clip); else whether its place is gone from `root`, the pane showing its file */
  orphan?: false | ((c: Comment, root: HTMLElement) => boolean);
  /** drawn as an outline (not as text) over `root`, its file's text root: where it is now, read on each paint; null: not shown */
  place?(c: Comment, root: HTMLElement | undefined): (() => DOMRect | null) | null;
}

/** What the plugins contribute, built once per store from its plugins and frozen. */
export interface Registry {
  tabs: ReadonlyMap<string, AnyTabView>;
  /** each slot's contributions by ascending order */
  slots: ReadonlyMap<SlotName, readonly Slot[]>;
  /** the core's and the plugins' hotkeys by ascending order */
  commands: readonly Command[];
  feed: ReadonlyMap<FeedKind, AnyFeedRenderer>;
  tools: readonly ToolRenderer[];
  /** by ascending order */
  userParts: readonly UserPart[];
  /** by ascending order */
  fileViews: readonly FileView[];
  anchorViews: ReadonlyMap<AnchorKind, AnchorView>;
}

/**
 * Each kind once: a kind two plugins claim is a build error, as a slice name taken twice is. So is one order taken
 * twice in a slot: the frame's order is never left to the order of `PLUGINS`. Commands alike: one id, one order each,
 * the core's own (`core`: the store passes the keymap's `CORE_COMMANDS`) among them.
 */
export function buildRegistry(plugins: readonly Plugin[], core: readonly Command[] = []): Registry {
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
  for (const c of [...core, ...plugins.flatMap((p) => p.commands ?? [])]) {
    if (commands.some((x) => x.id === c.id)) throw new Error(`registry: the command "${c.id}" is declared twice`);
    if (commands.some((x) => x.order === c.order)) throw new Error(`registry: two commands at order ${c.order}`);
    commands.push(c);
  }
  const feed = new Map<FeedKind, AnyFeedRenderer>();
  for (const r of plugins.flatMap((p) => p.feed ?? [])) {
    if (feed.has(r.kind)) throw new Error(`registry: the feed item kind "${r.kind}" is drawn twice`);
    feed.set(r.kind, r);
  }
  const userParts: UserPart[] = [];
  for (const u of plugins.flatMap((p) => p.userParts ?? [])) {
    if (userParts.some((x) => x.order === u.order)) throw new Error(`registry: two user message parts at order ${u.order}`);
    userParts.push(u);
  }
  const fileViews: FileView[] = [];
  for (const v of plugins.flatMap((p) => p.fileViews ?? [])) {
    if (fileViews.some((x) => x.id === v.id)) throw new Error(`registry: the file view "${v.id}" is declared twice`);
    fileViews.push(v);
  }
  const anchorViews = new Map<AnchorKind, AnchorView>();
  for (const v of plugins.flatMap((p) => p.anchorViews ?? [])) {
    if (anchorViews.has(v.kind)) throw new Error(`registry: the anchor kind "${v.kind}" is shown twice`);
    anchorViews.set(v.kind, v);
  }
  return Object.freeze({
    tabs, slots, commands: Object.freeze(commands.sort((a, b) => a.order - b.order)),
    feed, tools: Object.freeze(plugins.flatMap((p) => p.tools ?? [])), userParts: Object.freeze(userParts.sort((a, b) => a.order - b.order)),
    fileViews: Object.freeze(fileViews.sort((a, b) => a.order - b.order)), anchorViews,
  });
}

/** How the feed draws items of this kind (the one place its type is narrowed to the kind's). */
export const feedRenderer = <K extends FeedKind>(r: Registry, kind: K): FeedRenderer<K> | undefined =>
  r.feed.get(kind) as FeedRenderer<K> | undefined;

/** The view of this tab's kind (the one place its type is narrowed to the tab's). */
export const tabView = <T extends Tab>(r: Registry, tab: T): TabView<T['kind']> | undefined =>
  r.tabs.get(tab.kind) as TabView<T['kind']> | undefined;

/** A tab's name, in the strip and its menu alike (issue 469); a kind no plugin shows is named by its kind. */
export const tabLabel = (r: Registry, tab: Tab, tr: typeof t, s: RootState): string => tabView(r, tab)?.label(tab, tr, s) ?? tab.kind;

/** How a comment on this anchor shows, when a plugin shows its kind (a text anchor is the comments' own). */
export const anchorView = (r: Registry, a: Anchor): AnchorView | undefined => ('kind' in a ? r.anchorViews.get(a.kind) : undefined);
