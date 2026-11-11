import { useEffect, useMemo, useRef } from 'react';
import { anchorSource, isAttachmentAnchor, isMediaAnchor, isPageAnchor, type AnchorSource, type Comment, type PageAnchor } from '@nota-bene/shared';
import { rangeForAnchor } from '@/anchors/text.ts';
import { areaRect, resolvePage } from '@/page/anchor.ts';
import { outOf, pageRoot, pageSelection, rangeRects, textRootOf } from '@/page/frame.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { fileKey } from '@/files/sources.ts';
import { openCommentCard, selectComments } from './slice.ts';

const PAD_X = 2;
const PAD_Y = 1;
const MARK = {
  sent: 'bg-primary/18',
  pending: 'bg-mark-pending/38',
} as const;
/** an element or an area of a page: an outline around it, the page stays readable underneath */
const OUTLINE = {
  sent: 'border-2 border-primary/70',
  pending: 'border-2 border-mark-pending-line bg-mark-pending/12',
} as const;
/** an outline larger than this (px, each side) opens its card only from its edge: inside, the text stays selectable */
const OUTLINE_INNER = 160;
const EDGE = 6;

/** One rect per line: getClientRects() also returns boxes of nested inline elements, so drop the contained ones. */
function lineRects(range: Range): DOMRect[] {
  const rs = rangeRects(range).filter((r) => r.width > 1 && r.height > 1);
  return rs.filter(
    (r, i) =>
      !rs.some(
        (o, j) =>
          j !== i && o.left <= r.left + 0.5 && o.right >= r.right - 0.5 && o.top <= r.top + 0.5 && o.bottom >= r.bottom - 0.5 &&
          (o.width * o.height > r.width * r.height || j < i),
      ),
  );
}

/** What a paint drew for one comment: a text range (one box per line), or the outline of a page element or area. */
type Drawn = { id: string; range: Range; place?: undefined } | { id: string; range?: undefined; place: () => DOMRect | null };
type Cached = { c: Comment; root: HTMLElement; range: Range };
type Source = AnchorSource;

/** The file a file pane shows: its path and, for another source, the ref (M3-16). undefined = the chat. */
type PaneFile = { path: string; ref?: string } | undefined;

/**
 * Whether a source lives in this pane: message sources in the chat (those of a subagent's conversation in that
 * subagent's tab: `agent`), a file source in the tab of that path AND ref.
 */
const inPane = (src: Source, file: PaneFile, agent?: string): boolean =>
  file === undefined ? src.kind === 'message' && src.agent === agent : src.kind === 'file' && src.path === file.path && (src.ref ?? '') === (file.ref ?? '');

/**
 * The commentable roots inside a pane, keyed by source: the chat's items (by id), or the file view's own text root:
 * the pane element itself, while FileView marks it with this tab's path and ref (only while it shows text). A
 * `data-file-path` inside rendered markdown is file content and never a root. A diff's root sits inside its pane.
 */
function rootsIn(pane: HTMLElement, file: PaneFile | null, isDiff: boolean): Map<string, HTMLElement> {
  const roots = new Map<string, HTMLElement>();
  if (isDiff) {
    const root = pane.querySelector<HTMLElement>('[data-file-path]');
    if (file && root?.dataset.filePath === file.path) roots.set(`f:${fileKey(file.path, file.ref)}`, root);
  } else if (file === undefined) {
    for (const e of pane.querySelectorAll<HTMLElement>('#items [data-item-id], [data-items] [data-item-id]')) if (e.dataset.itemId) roots.set(`m:${e.dataset.itemId}`, e);
  } else if (file && pane.dataset.filePath === file.path && (pane.dataset.fileRef ?? '') === (file.ref ?? '')) {
    roots.set(`f:${fileKey(file.path, file.ref)}`, textRootOf(pane)); // a rendered page: its body, in the page's frame
  }
  return roots;
}
const keyOf = (src: Source) => (src.kind === 'message' ? `m:${src.id}` : `f:${fileKey(src.path, src.ref)}`);

/**
 * The Range of a comment's text, or null for an orphan / a source that is not (yet) in the DOM or not commentable.
 * A cached range is reused while the comment object and its root element are unchanged and the range is still live;
 * otherwise the anchor is resolved again (one text-model build). A file reload with new text replaces the text nodes
 * (Markdown sets innerHTML, CodeText sets textContent), so `isConnected` drops the stale range; an unchanged text keeps them.
 */
function rangeOf(roots: Map<string, HTMLElement>, cache: Map<string, Cached>, c: Comment): Range | null {
  if (isMediaAnchor(c.anchor) || isPageAnchor(c.anchor) || isAttachmentAnchor(c.anchor)) return null; // media marks are drawn over the media, page places as outlines
  const root = roots.get(keyOf(c.anchor.source));
  if (!root || (root.dataset.kind === 'assistant' && root.dataset.final !== 'true')) return null;
  const hit = cache.get(c.id);
  if (hit && hit.c === c && hit.root === root && hit.range.startContainer.isConnected && !hit.range.collapsed) return hit.range;
  const range = rangeForAnchor(root, c.anchor);
  if (range) cache.set(c.id, { c, root, range });
  return range;
}

/**
 * Where a page anchor is now, in this window's coordinates (the element's box, or the area through the SVG's transform),
 * read again on every call: the page lays out on its own. null: the page is not shown, or the place is gone.
 */
function placeOf(root: HTMLElement | undefined, a: PageAnchor): (() => DOMRect | null) | null {
  const doc = root?.hasAttribute('data-page-root') ? root.ownerDocument : null;
  const el = doc && resolvePage(doc, a);
  if (!el) return null;
  return () => {
    if (!el.isConnected) return null;
    const r = a.box ? areaRect(el, a.box) : el.getBoundingClientRect();
    return r && r.width + r.height > 0 ? outOf(el, r) : null;
  };
}

/** Whether a click lands on a drawn outline: anywhere on a small one, on the edge of a large one. */
function onOutline(r: DOMRect, x: number, y: number): boolean {
  const inside = (p: number) => x >= r.left - p && x <= r.right + p && y >= r.top - p && y <= r.bottom + p;
  if (!inside(EDGE)) return false;
  if (r.width <= OUTLINE_INNER && r.height <= OUTLINE_INNER) return true;
  return !(x > r.left + EDGE && x < r.right - EDGE && y > r.top + EDGE && y < r.bottom - EDGE);
}

/** Positions boxes (this window's coordinates) in the coordinates of a layer at the pane's content origin. */
function placeBoxes(rects: DOMRect[], pane: HTMLElement, className: string, data?: Record<string, string>): HTMLElement[] {
  const base = pane.getBoundingClientRect();
  return rects.map((r) => {
    const m = document.createElement('div');
    if (data) Object.assign(m.dataset, data);
    m.className = `absolute rounded-[4px] ${className}`;
    m.style.left = `${r.left - base.left + pane.scrollLeft - PAD_X}px`;
    m.style.top = `${r.top - base.top + pane.scrollTop - PAD_Y}px`;
    m.style.width = `${r.width + PAD_X * 2}px`;
    m.style.height = `${r.height + PAD_Y * 2}px`;
    return m;
  });
}

/** One box per line of `range`, placed in the pane's layer. */
const boxes = (range: Range, pane: HTMLElement, className: string, data?: Record<string, string>): HTMLElement[] =>
  placeBoxes(lineRects(range), pane, className, data);

/** A one-off flash over a fragment (jump to source in a file): drawn in the pane's layer, apart from the marks it repaints. */
export function flashRange(pane: HTMLElement, range: Range) {
  flashRects(pane, lineRects(range));
}

/** The same flash over boxes in this window's coordinates (a page element or area). */
export function flashRects(pane: HTMLElement, rects: DOMRect[]) {
  const host = pane.querySelector<HTMLElement>(':scope > [data-hl-layer] > [data-hl-flash]');
  if (!host) return;
  const nodes = placeBoxes(rects, pane, 'nb-flash');
  host.append(...nodes);
  setTimeout(() => nodes.forEach((n) => n.remove()), 1300);
}

/**
 * Highlight marks over commented text, one layer per pane (`pane` is the tab id: 'chat' or a file tab). Lives inside
 * the pane's scroll element so the marks scroll with the content, and paints only the comments whose source lives in
 * that pane. A hidden pane paints nothing (its rects are all zero) and repaints when it becomes active. The layer
 * ignores pointer events (marks would block text selection), so clicks are hit-tested against the ranges' line rects
 * on the pane in the capture phase. A diff view passes the file it shows (`diff`, null for none) and what repaints it (`content`).
 */
export function HighlightLayer({ pane: paneId = 'chat', diff, content: diffContent }: { pane?: string; diff?: { path: string; ref?: string } | null; content?: unknown }) {
  const layer = useRef<HTMLDivElement>(null);
  const marks = useRef<HTMLDivElement>(null);
  const drawn = useRef<Drawn[]>([]); // topmost last
  const cache = useRef(new Map<string, Cached>());
  const paint = useRef<() => void>(() => {});
  const dispatch = useAppDispatch();
  const all = useAppSelector(selectComments);
  const active = useAppSelector((s) => s.tabs.active === paneId);
  // the file this pane shows (path + ref); null = a file pane whose tab is gone
  const path = useAppSelector((s) => {
    const tab = s.tabs.open.find((t) => t.id === paneId);
    return tab?.kind === 'file' ? tab.path : undefined;
  });
  const ref = useAppSelector((s) => {
    const tab = s.tabs.open.find((t) => t.id === paneId);
    return tab?.kind === 'file' ? tab.ref : undefined;
  });
  // a subagent's tab (`agent:<toolUseId>`) draws its conversation like the chat; its comments carry `source.agent`
  const agent = paneId.startsWith('agent:') ? paneId.slice('agent:'.length) : undefined;
  const asChat = paneId === 'chat' || agent !== undefined;
  const isDiff = diff !== undefined;
  const file: PaneFile | null = useMemo(() => (isDiff ? diff : asChat ? undefined : path === undefined ? null : { path, ref }), [isDiff, diff, asChat, path, ref]);
  const comments = useMemo(() => (file === null ? [] : all.filter((c) => { const src = anchorSource(c.anchor); return !!src && inPane(src, file, agent); })), [all, file, agent]);
  // what moves this pane's text: the feed for the chat (the subagent's entry for its tab); a settled (re)load for a file tab
  const stored = useAppSelector((s) => (agent ? s.subagents.byTool[agent] : paneId === 'chat' ? s.feed : path === undefined ? undefined : s.files.load[fileKey(path, ref)]));
  // the chat's action panels open and close without a feed change (their roots come and go)
  const folds = useAppSelector((s) => (asChat ? s.feedUi : undefined));
  const content = isDiff ? diffContent : stored;
  const state = useRef({ comments, active, file, isDiff });
  state.current = { comments, active, file, isDiff };

  useEffect(() => {
    const el = layer.current;
    const pane = el?.parentElement;
    const host = marks.current;
    if (!el || !pane || !host) return;
    let raf = 0;
    // layout changes that do not resize the pane: the chat's #items, and a file root's content (it is the scroll element itself)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => paint.current());
    const observed = new WeakSet<Element>();
    const observe = (e: Element) => {
      if (!observed.has(e)) { observed.add(e); ro?.observe(e); }
    };
    const draw = () => {
      raf = 0;
      if (!state.current.active) {
        drawn.current = [];
        host.replaceChildren();
        return; // the cache is kept: its ranges stay valid while hidden, and are re-checked on the next paint
      }
      const list: (Drawn & { kind: 'sent' | 'pending' })[] = [];
      const roots = rootsIn(pane, state.current.file, state.current.isDiff);
      for (const [k, r] of roots) if (k.startsWith('f:')) for (const e of r.children) if (!e.hasAttribute('data-hl-layer')) observe(e);
      // a page's frame grows with the page (HtmlBody sets its height): what moves the page's marks
      if (pageRoot(pane)) for (const e of pane.children) if (!e.hasAttribute('data-hl-layer')) observe(e);
      const prev = cache.current;
      const next = new Map<string, Cached>(); // only what this paint drew survives: removed / orphaned comments drop out
      for (const c of state.current.comments) {
        if (isPageAnchor(c.anchor)) {
          const place = placeOf(roots.get(`f:${fileKey(c.anchor.source.path, c.anchor.source.ref)}`), c.anchor);
          if (place) list.push({ id: c.id, place, kind: c.status });
          continue;
        }
        const hit = prev.get(c.id);
        if (hit) next.set(c.id, hit);
        const range = rangeOf(roots, next, c);
        if (range) list.push({ id: c.id, range, kind: c.status });
        else next.delete(c.id);
      }
      cache.current = next;
      list.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'sent' ? -1 : 1)); // pending painted last = on top
      drawn.current = list;
      host.replaceChildren(...list.flatMap((d) => {
        if (d.range) return boxes(d.range, pane, MARK[d.kind], { hl: d.kind });
        const r = d.place();
        return r ? placeBoxes([r], pane, OUTLINE[d.kind], { hl: d.kind, hlPlace: d.id }) : [];
      }));
    };
    paint.current = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    observe(pane);
    const items = pane.querySelector('#items, [data-items]');
    if (items) observe(items);
    const onLoad = () => paint.current(); // images / video change layout once loaded
    pane.addEventListener('load', onLoad, true);
    void document.fonts?.ready.then(() => paint.current());

    const onClick = (e: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed || pageSelection(pane)) return;
      for (let i = drawn.current.length - 1; i >= 0; i--) {
        const d = drawn.current[i];
        const place = d.place?.();
        const hit = d.range ? lineRects(d.range).find(
          (r) => e.clientX >= r.left - PAD_X && e.clientX <= r.right + PAD_X && e.clientY >= r.top - PAD_Y && e.clientY <= r.bottom + PAD_Y,
        ) : place && onOutline(place, e.clientX, e.clientY) ? place : undefined;
        if (!hit) continue;
        e.stopPropagation();
        e.preventDefault();
        dispatch(openCommentCard({ id: drawn.current[i].id, x: hit.left, y: hit.bottom }));
        return;
      }
    };
    pane.addEventListener('click', onClick, true);
    paint.current();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      pane.removeEventListener('load', onLoad, true);
      pane.removeEventListener('click', onClick, true);
      paint.current = () => {};
    };
  }, [dispatch]);

  // comments, content or visibility changed: React has committed the DOM (and unhidden the pane), repaint on the next frame
  useEffect(() => paint.current(), [comments, content, folds, active]);

  return (
    <div ref={layer} aria-hidden="true" data-anchor-skip data-hl-layer={paneId} className="pointer-events-none absolute inset-0">
      <div ref={marks} />
      <div data-hl-flash />
    </div>
  );
}
