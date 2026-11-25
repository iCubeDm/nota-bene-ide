import type { FC, MutableRefObject, Ref, SyntheticEvent } from 'react';
import type { Anchor, Comment, ImageRef, ImageType, MediaAnchor, TextAnchor } from '@nota-bene/shared';
import type { I18nKey, Lang, t } from '../i18n/index.ts';
import type { ru } from '../i18n/ru.ts';
import type { AppDispatch, AppStore, AppThunk, RootState } from '../store/store.ts';
import type { FeedItem } from '../store/feed.ts';
import type { FileKind } from '../refs/kinds.ts';
import type { Tab, TabKinds } from '../tabs/slice.ts';
import type { Plugin } from './plugin.ts';
import type { Resource } from './repository.ts';

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
 * chat pane; over the panes; the footer; the overlays after the frame. The composer's (issue 545): its status line, its
 * tools row after the keys help and at its right end, and the pickers of a message field, which the comment popup shares
 * (a picker reads its field with `useComposerField()`). `tabs.chat`: inside the chat's tab, at its end
 * (issue 653: this page's agent's ✕).
 */
export type SlotName = 'header.title' | 'header.center' | 'header.end' | 'header.menu' | 'header.badge' | 'strip.left' | 'strip.right' | 'tabs.chat'
  | 'panel.left' | 'panel.right' | 'chat' | 'panes' | 'footer' | 'overlay' | 'home'
  | 'composer.status' | 'composer.tools' | 'composer.end' | 'composer.pickers';

/** A plugin's part of the frame: rendered at `slot` by ascending `order`, with the frame's own parts (see `Slots`). */
export interface Slot {
  slot: SlotName;
  order: number;
  render: FC;
  /** where it shows (issue 651): absent, an agent's page only; `home`, the server's home page only; `both` */
  on?: 'home' | 'both';
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
  inModal?: (s: RootState) => boolean;
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

/** How the feed (`plugins/feed/Feed.tsx`) draws its items of one kind (issue 511); a kind is drawn by one plugin only. */
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
 * How a file tab shows a file of some kind (issue 511): the file tab (`plugins/files/FileView.tsx`) keeps the header, the load
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
  /**
   * One picture for comments of one send marking one frame, uploaded (its attachment id): the first one's frame image,
   * every member's shapes and its number in the batch. Rejects when it cannot be made: each goes with its own frame.
   */
  composite?(members: { n: number; comment: Comment }[]): Promise<string>;
}

/** What only a drawing's `prepare` knows for sure; merged into the anchor before the comment is added. */
export type MediaAnchorPatch = Partial<Pick<MediaAnchor, 'scale' | 'version' | 'time' | 'width' | 'height'>>;

/**
 * What the comment popup comments on. A text selection: anchor + rect (+ the letter typed to open it). A media drawing
 * adds `id` (the comment id, which names its mark folder), `prepare` (renders and uploads the frame and the layer, and
 * returns their attachment ids plus what only it knows for sure: the exact time, the version, the scale; on failure it
 * has already removed the folder) and `discard` (removes the folder of a comment that never came to be).
 */
export type PendingComment = {
  anchor: Anchor; rect: DOMRect; text?: string;
  id?: string; prepare?: () => Promise<{ images: string[]; anchor?: MediaAnchorPatch }>; discard?: () => Promise<void>;
};

export type MediaComment = Comment & { anchor: MediaAnchor };

/** An uploaded image of a message or a comment. */
export type ImageEntry = { id: string; mediaType: ImageType };
/** The media as other plugins' views play it (issue 545), provided by the media plugin. */
export interface MediaService {
  /** the player bar over a reply's video or audio element, inside its wrapper `box` */
  ChatPlayer: FC<{ media: HTMLMediaElement; box: HTMLElement }>;
  /** the full-window markup of the message's attached image `id`, over the composer */
  AttachmentMarkup: FC<{ id: string; onClose: () => void }>;
}

/**
 * A fenced code block a plugin draws instead of highlighting it (issue 545): once the text is final, the block's
 * `<pre>` gives way to an empty `<div class={className}>` that `draw` fills. `retheme`: the theme changed; the blocks
 * under `root` draw again if they need to.
 */
export interface CodeBlock {
  /** the fence's language */
  lang: string;
  className: string;
  draw(out: HTMLElement, code: string, d: AppDispatch): void;
  retheme?(root: HTMLElement, d: AppDispatch): void;
}

/**
 * Another plugin's part of a file row in the Files tree (issue 545): its menu items, above the row's own, and what the
 * row's drag carries for it. By ascending order.
 */
export interface TreeAction {
  id: string;
  order: number;
  /** `picked`: the files the menu acts on, in the order picked; `busy`: the tree's spinner (one such job at a time) */
  Menu?: FC<{ row: string; picked: readonly string[]; src: string; busy: boolean; setBusy: (on: boolean) => void }>;
  /** a file row of the source `src` starts to drag: what it carries for this plugin */
  drag?(path: string, src: string, dt: DataTransfer): void;
}

/**
 * A plugin's service to other plugins (issue 545): each is provided by one plugin, and read with `useService(name)` in
 * a view or `registry.<name>` in a thunk. Its interface lives with its provider, which adds it here by declaration
 * merging (`declare module '@/sdk' { interface Services { files: FilesService } }`, issue 563); only one the core reads
 * itself is declared here.
 */
export interface Services {
  media: MediaService;
}
/** What a plugin contributes besides its services: every other key of a plugin is a service. */
const CONTRIBUTIONS = new Set(['id', 'slices', 'middleware', 'listeners', 'pause', 'tabs', 'slots', 'commands', 'feed', 'tools', 'userParts',
  'fileViews', 'anchorViews', 'sendParts', 'settings', 'resources', 'codeBlocks', 'treeActions']);

/**
 * How a send ended (`chat.send`). 'building': a part is being made ready (a combined image); the send finishes by
 * itself. 'changed': a part changed, or the session did, while it waited; nothing went. 'blocked', 'detached', 'empty':
 * nothing taken, a part said why.
 */
export type SendResult = 'detached' | 'empty' | 'blocked' | 'sent' | 'offline' | 'switching' | 'building' | 'changed';

/** What a part knows of the send taking it. */
interface TakeCtx {
  /** a recording's send: no draft, nothing waits */
  voice: boolean;
  registry: Registry;
}

/** What a part took at the click: its items are its own until it is composed, or given back. */
export interface Taken {
  /** resolved once it can be composed; the send waits for it up to `COMPOSITE_MS` */
  ready?: Promise<void>;
  /** still what was taken (checked after the wait) */
  unchanged?(s: RootState): boolean;
  /** its part of the message; `images`: the message's images before its own, numbered from 1 */
  compose(ctx: { s: RootState; lang: Lang; images: readonly ImageRef[] }): { text?: string; images?: ImageRef[]; commentIds?: string[] };
  /** the message went, as `id` */
  sent?(id: string): void;
  /** the message did not go, or the server refused it: what was taken is the part's again */
  released?(): void;
}

/**
 * A part of the message a send collects (issue 511): the composer's draft, the comments riding along. Taken in
 * ascending order at the click; a result instead of a `Taken` ends the send there (a `! cmd` run, a held /clear).
 */
export interface SendPart {
  id: string;
  order: number;
  /** the items it would take now: the Send button's count */
  count?(s: RootState): number;
  /** it holds items that wait, even ones that cannot go now (a /clear and a `! cmd` wait for them) */
  waiting?(s: RootState): boolean;
  take(s: RootState, d: AppDispatch, o: TakeCtx): Taken | SendResult | null;
}

/**
 * A part of the Settings tab (issue 511): a section under its heading, or, with `in`, a row of the section of that id.
 * Sections by ascending order; a section's rows by ascending order after its own body.
 */
export interface SettingsSection {
  id: string;
  order: number;
  /** a section's heading (a row has none) */
  title?: I18nKey;
  /** the section this row sits in */
  in?: string;
  /** `active`: the tab is shown, so a part reads its data now; none: a section of rows only */
  render?: FC<{ active: boolean }>;
}

/** What the plugins contribute, built once per store from its plugins and frozen. */
export interface Registry extends Partial<Services> {
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
  /** by ascending order */
  sendParts: readonly SendPart[];
  /** sections and rows, by ascending order */
  settings: readonly SettingsSection[];
  /** the server data the plugins read, by id (a test answers one by its id) */
  resources: ReadonlyMap<string, Resource<never, unknown>>;
  /** the fenced code blocks the plugins draw, by language */
  codeBlocks: ReadonlyMap<string, CodeBlock>;
  /** the parts of a file row in the Files tree, by ascending order */
  treeActions: readonly TreeAction[];
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
  const sendParts: SendPart[] = [];
  for (const p of plugins.flatMap((x) => x.sendParts ?? [])) {
    if (sendParts.some((x) => x.id === p.id)) throw new Error(`registry: the send part "${p.id}" is declared twice`);
    if (sendParts.some((x) => x.order === p.order)) throw new Error(`registry: two send parts at order ${p.order}`);
    sendParts.push(p);
  }
  const settings: SettingsSection[] = [];
  for (const x of plugins.flatMap((p) => p.settings ?? [])) {
    if (settings.some((y) => y.id === x.id)) throw new Error(`registry: the settings part "${x.id}" is declared twice`);
    if (settings.some((y) => y.in === x.in && y.order === x.order)) throw new Error(`registry: two settings parts ${x.in ? `in "${x.in}" ` : ''}at order ${x.order}`);
    settings.push(x);
  }
  const resources = new Map<string, Resource<never, unknown>>();
  for (const r of plugins.flatMap((p) => p.resources ?? [])) {
    if (!r.id) throw new Error('registry: a registered resource needs an id');
    if (resources.has(r.id)) throw new Error(`registry: the resource "${r.id}" is declared twice`);
    resources.set(r.id, r);
  }
  const codeBlocks = new Map<string, CodeBlock>();
  for (const b of plugins.flatMap((p) => p.codeBlocks ?? [])) {
    if (codeBlocks.has(b.lang)) throw new Error(`registry: the code block "${b.lang}" is drawn twice`);
    codeBlocks.set(b.lang, b);
  }
  const treeActions: TreeAction[] = [];
  for (const a of plugins.flatMap((p) => p.treeActions ?? [])) {
    if (treeActions.some((x) => x.id === a.id)) throw new Error(`registry: the tree action "${a.id}" is declared twice`);
    if (treeActions.some((x) => x.order === a.order)) throw new Error(`registry: two tree actions at order ${a.order}`);
    treeActions.push(a);
  }
  const services: Record<string, unknown> = {};
  for (const p of plugins) {
    for (const [k, v] of Object.entries(p)) {
      if (CONTRIBUTIONS.has(k) || v === undefined) continue;
      if (k in services) throw new Error(`registry: two plugins provide the ${k}`);
      services[k] = v;
    }
  }
  return Object.freeze({
    tabs, slots, commands: Object.freeze(commands.sort((a, b) => a.order - b.order)),
    feed, tools: Object.freeze(plugins.flatMap((p) => p.tools ?? [])), userParts: Object.freeze(userParts.sort((a, b) => a.order - b.order)),
    fileViews: Object.freeze(fileViews.sort((a, b) => a.order - b.order)), anchorViews,
    sendParts: Object.freeze(sendParts.sort((a, b) => a.order - b.order)),
    settings: Object.freeze(settings.sort((a, b) => a.order - b.order)), resources,
    codeBlocks, treeActions: Object.freeze(treeActions.sort((a, b) => a.order - b.order)), ...services,
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
