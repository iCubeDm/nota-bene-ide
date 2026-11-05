import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { isPageAnchor, isTextAnchor, type FileSource } from '@nota-bene/shared';
import { scrollRangeIntoView, scrollRectIntoView } from '@/anchors/scroll.ts';
import { rangeForAnchor } from '@/anchors/text.ts';
import { CommentPopup, type PendingComment } from '@/comments/CommentPopup.tsx';
import { flashRange, flashRects, HighlightLayer } from '@/comments/HighlightLayer.tsx';
import { selectComments } from '@/comments/slice.ts';
import { useT } from '@/i18n/index.ts';
import { areaAnchor, areaRect, elementAnchor, nearOf, pickTarget, resolvePage, toUserBox } from '@/page/anchor.ts';
import { outOf, pageRendered } from '@/page/frame.ts';
import { preparePage } from '@/page/prep.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { openFile } from '@/tabs/slice.ts';
import { clearJump, selectJump } from '../slice.ts';

/** how often (ms) a shown page is measured: the frame takes the page's height, so the pane scrolls it */
const MEASURE_MS = 400;
/** a page whose height keeps growing by the same step (a `100vh` block plus a margin) stops growing after this many */
const GROW_STREAK = 3;
const HEIGHT_MAX = 200_000;
/** a drag shorter than this (px) is a click */
const DRAG_MIN = 4;

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
type Box = { left: number; top: number; right: number; bottom: number };

/** Copies an event of the page's window onto the frame element here, in this window's coordinates; true if a listener here took it. */
function forward(frame: HTMLIFrameElement, e: MouseEvent | KeyboardEvent): boolean {
  const mods = { ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, bubbles: true, cancelable: true };
  let copy: Event;
  if ('key' in e) copy = new KeyboardEvent(e.type, { ...mods, key: e.key, code: e.code, repeat: e.repeat, isComposing: e.isComposing });
  else {
    const r = frame.getBoundingClientRect();
    copy = new MouseEvent(e.type, { ...mods, button: e.button, buttons: e.buttons, detail: e.detail, clientX: e.clientX + r.left, clientY: e.clientY + r.top });
  }
  return !frame.dispatchEvent(copy);
}

/**
 * A rendered `.html` file: the page in a sandboxed frame (no script of it ever runs: the window holds the access key),
 * as tall as the page, inside the pane that scrolls it. Its text is commented on like a Markdown file's (the frame's
 * body is the text root, see page/frame.ts). `marking`: a click comments on an element, a drag inside an SVG on an area.
 */
export function HtmlBody({ html, path, src, fileRef, tabId, active, paneRef, marking, onScripts }: {
  html: string; path: string; src: string; fileRef: string | undefined; tabId: string; active: boolean;
  paneRef: Ref<HTMLDivElement>; marking: boolean; onScripts: (has: boolean) => void;
}) {
  const t = useT();
  const dispatch = useAppDispatch();
  const baseDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined;
  const page = useMemo(() => preparePage(html, baseDir, src), [html, baseDir, src]);
  useEffect(() => onScripts(page.scripts), [page.scripts, onScripts]);
  const frame = useRef<HTMLIFrameElement>(null);
  const pane = useRef<HTMLDivElement | null>(null);
  const hover = useRef<HTMLDivElement>(null);
  const drag = useRef<HTMLDivElement>(null);
  // the old height stays through a reload: the pane keeps its scroll while the new page lays out
  const [height, setHeight] = useState(0);
  const [rendered, setRendered] = useState(0);
  const [popup, setPopup] = useState<PendingComment | null>(null);
  const source: FileSource = useMemo(() => (fileRef ? { kind: 'file', path, ref: fileRef } : { kind: 'file', path }), [path, fileRef]);
  const now = useRef({ marking, popup, source, src, baseDir, active });
  now.current = { marking, popup, source, src, baseDir, active };

  const setPane = (el: HTMLDivElement | null) => {
    pane.current = el;
    if (typeof paneRef === 'function') paneRef(el);
    else if (paneRef) (paneRef as { current: HTMLDivElement | null }).current = el;
  };

  // the page's height, measured while it is shown; a page that grows with its frame is stopped after a few steps
  useEffect(() => {
    if (!active || !rendered) return;
    let step = 0, streak = 0;
    const measure = () => {
      const doc = frame.current?.contentDocument;
      if (!doc?.documentElement) return;
      const h = Math.min(HEIGHT_MAX, doc.documentElement.scrollHeight);
      setHeight((old) => {
        if (h === old) return old;
        const d = h - old;
        streak = d > 0 && d === step ? streak + 1 : 0;
        step = d;
        return streak >= GROW_STREAK ? old : h;
      });
    };
    measure();
    const id = setInterval(measure, MEASURE_MS);
    return () => clearInterval(id);
  }, [active, rendered]);

  // what the page's window does that this window must hear: clicks and keys (the selection bar, the comment cards,
  // the hotkeys), links (never followed inside the frame), and the marking gestures
  useEffect(() => {
    const f = frame.current;
    const doc = f?.contentDocument;
    if (!f || !doc || !rendered) return;
    const show = (el: HTMLDivElement | null, r: Box | null) => {
      const p = pane.current;
      if (!el || !p) return;
      if (!r) return void (el.hidden = true);
      const base = p.getBoundingClientRect();
      Object.assign(el.style, { left: `${r.left - base.left + p.scrollLeft}px`, top: `${r.top - base.top + p.scrollTop}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
      el.hidden = false;
    };
    const targetOf = (e: Event): Element | null => (e.target && (e.target as Node).nodeType === Node.ELEMENT_NODE ? e.target as Element : (e.target as Node | null)?.parentElement ?? null);
    let start: { x: number; y: number; svg: Element | null } | null = null;
    const areaOf = (e: MouseEvent): Box | null => {
      if (!start?.svg || Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_MIN) return null;
      const s = start.svg.getBoundingClientRect();
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      const x1 = clamp(start.x, s.left, s.right), x2 = clamp(e.clientX, s.left, s.right);
      const y1 = clamp(start.y, s.top, s.bottom), y2 = clamp(e.clientY, s.top, s.bottom);
      return { left: Math.min(x1, x2), top: Math.min(y1, y2), right: Math.max(x1, x2), bottom: Math.max(y1, y2) };
    };
    const inParent = (r: Box): Box => {
      const o = outOf(doc.body, new DOMRect(r.left, r.top, r.right - r.left, r.bottom - r.top));
      return { left: o.left, top: o.top, right: o.right, bottom: o.bottom };
    };

    const onMove = (e: MouseEvent) => {
      if (!now.current.marking || now.current.popup) return;
      const area = areaOf(e);
      if (area) {
        show(drag.current, inParent(area));
        return show(hover.current, null);
      }
      const el = start ? null : pickTarget(targetOf(e) ?? doc.body);
      show(hover.current, el ? inParent(el.getBoundingClientRect()) : null);
    };
    const onDown = (e: MouseEvent) => {
      // an open popup closes on a click outside it, also one on the page
      if (!now.current.marking || now.current.popup) return void forward(f, e);
      if (e.button !== 0) return;
      e.preventDefault(); // no text selection while marking
      start = { x: e.clientX, y: e.clientY, svg: targetOf(e)?.closest('svg') ?? null };
    };
    const onUp = (e: MouseEvent) => {
      if (!now.current.marking) return void forward(f, e);
      if (!start) return;
      const area = areaOf(e);
      const svg = start.svg;
      start = null;
      show(drag.current, null);
      show(hover.current, null);
      const { source: s } = now.current;
      if (area && svg) {
        const box = toUserBox(svg, area);
        if (!box) return;
        const r = inParent(area);
        const anchor = areaAnchor(s, svg, box, nearOf(svg, area));
        if (anchor) setPopup({ anchor, rect: new DOMRect(r.left, r.top, r.right - r.left, r.bottom - r.top) });
        return;
      }
      const el = pickTarget(targetOf(e) ?? doc.body);
      if (!el) return;
      const anchor = elementAnchor(s, el);
      if (anchor) setPopup({ anchor, rect: outOf(el, el.getBoundingClientRect()) });
    };
    const onClick = (e: MouseEvent) => {
      const a = targetOf(e)?.closest('a[href]');
      if (now.current.marking || a) e.preventDefault();
      if (now.current.marking) return;
      if (forward(f, e)) return;
      const href = a?.getAttribute('href')?.trim();
      if (!href) return;
      if (href.startsWith('#')) {
        const to = doc.getElementById(decodeURIComponent(href.slice(1)));
        if (to && pane.current) scrollRectIntoView(outOf(to, to.getBoundingClientRect()), pane.current);
      } else if (/^(https?|mailto):/i.test(href)) {
        window.open(href, '_blank', 'noopener,noreferrer');
      } else if (!/^[a-z][a-z0-9+.-]*:|^\//i.test(href)) {
        // a file beside the page: opens as a tab, like a path in the chat
        const rel = decodeURIComponent(new URL(href, `http://x/${now.current.baseDir ? `${now.current.baseDir}/` : ''}`).pathname.slice(1));
        if (rel) dispatch(openFile({ path: rel, src: now.current.src }));
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const el = targetOf(e);
      if (el?.closest(EDITABLE)) return; // typing in the page's own field
      if (forward(f, e)) e.preventDefault();
    };
    const onLeave = () => show(hover.current, null);
    doc.addEventListener('mousemove', onMove);
    doc.addEventListener('mousedown', onDown);
    doc.addEventListener('mouseup', onUp);
    doc.addEventListener('click', onClick);
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('mouseleave', onLeave);
    return () => {
      doc.removeEventListener('mousemove', onMove);
      doc.removeEventListener('mousedown', onDown);
      doc.removeEventListener('mouseup', onUp);
      doc.removeEventListener('click', onClick);
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('mouseleave', onLeave);
    };
  }, [rendered, dispatch]);

  // marking: the page shows it by its cursor; leaving it drops what was being shown
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (doc?.documentElement) doc.documentElement.style.cursor = marking ? 'crosshair' : '';
    if (!marking && hover.current) hover.current.hidden = true;
  }, [marking, rendered]);

  // "jump to source": once the page is on screen, scroll to the fragment or the place and flash it
  const jump = useAppSelector(selectJump);
  const comments = useAppSelector(selectComments);
  useEffect(() => {
    const p = pane.current;
    const body = frame.current?.contentDocument?.body;
    if (jump?.path !== path || jump.src !== src || !active || !rendered || !p || !body) return;
    dispatch(clearJump());
    const c = comments.find((x) => x.id === jump.id);
    if (!c) return;
    if (isTextAnchor(c.anchor)) {
      const range = rangeForAnchor(body, c.anchor);
      if (!range) return;
      scrollRangeIntoView(range, p);
      flashRange(p, range);
    } else if (isPageAnchor(c.anchor)) {
      const el = resolvePage(body.ownerDocument, c.anchor);
      const r = el && (c.anchor.box ? areaRect(el, c.anchor.box) : el.getBoundingClientRect());
      if (!el || !r) return;
      const at = outOf(el, r);
      scrollRectIntoView(at, p);
      // the flash is placed after the smooth scroll has moved the page
      setTimeout(() => {
        const again = isPageAnchor(c.anchor) && c.anchor.box ? areaRect(el, c.anchor.box) : el.getBoundingClientRect();
        if (again) flashRects(p, [outOf(el, again)]);
      }, 350);
    }
  }, [jump, active, rendered, path, src, comments, dispatch]);

  const onLoad = () => {
    const doc = frame.current?.contentDocument;
    if (!doc?.body) return;
    doc.body.setAttribute('data-page-root', '');
    setHeight(Math.min(HEIGHT_MAX, doc.documentElement.scrollHeight));
    setRendered((n) => n + 1);
    pageRendered();
  };

  return (
    <div
      ref={setPane} data-pane={tabId} data-file-path={path} data-file-ref={fileRef} data-page-pane hidden={!active}
      className="grid-pane relative min-h-0 flex-1 overflow-auto"
    >
      <iframe
        ref={frame} data-page-frame title={path} sandbox="allow-same-origin" srcDoc={page.doc} onLoad={onLoad}
        className="block w-full border-0 bg-white [color-scheme:light]" style={{ height: height || '100%' }}
      />
      <div ref={hover} hidden data-page-hover className="pointer-events-none absolute rounded-[3px] border-2 border-nb-accent bg-nb-accent/10" />
      <div ref={drag} hidden data-page-drag className="pointer-events-none absolute border-2 border-dashed border-nb-accent bg-nb-accent/15" />
      <HighlightLayer pane={tabId} />
      {marking && active && !popup && (
        <div data-anchor-skip className="pointer-events-none sticky bottom-3 z-10 mx-auto w-fit rounded-md bg-popover px-3 py-1.5 text-xs text-muted-foreground shadow">
          {t('pageMarkHint')}
        </div>
      )}
      {popup && createPortal(
        <div className="relative z-30" hidden={!active}>
          <CommentPopup key={popup.rect.x + ':' + popup.rect.y} pending={popup} onClose={() => setPopup(null)} hidden={!active} />
        </div>,
        document.body,
      )}
    </div>
  );
}
