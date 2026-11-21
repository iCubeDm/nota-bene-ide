import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import './hljs.css';
import { marked } from 'marked';
import { memo, type MouseEvent as ReactMouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'react-redux';
import { t } from '../../i18n/index.ts';
import { toast } from '../../shell/toast.ts';
import { theme } from '../../shell/theme.ts';
import { AUDIO, VIDEO, fileUrl } from '../../refs/kinds.ts';
import { useSources } from '../../refs/sources.ts';
import { setStartAt } from '../../refs/startAt.ts';
import { fileOfImage, markMentions, markRefs, openMediaFile } from '../../refs/refs.ts';
import { fileTabId } from '../../tabs/slice.ts';
import { registry, useAppSelector, type AppDispatch, type AppStore } from '../../store/store.ts';
import { selectTmpDirs } from '../../store/controls.ts';
import type { CodeBlock } from '../../sdk/registry.ts';
import { addCopyButton, copyCode, numberLines } from './codeBlock.ts';
import { HARDEN } from './harden.ts';
import './markdown.css';

// external links in agent replies open in a new browser tab instead of replacing the app
DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.tagName === 'A' && /^https?:/i.test(n.getAttribute('href') ?? '')) {
    n.setAttribute('target', '_blank');
    n.setAttribute('rel', 'noopener noreferrer');
  }
});

const escAttr = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// marked renderers are global and parse is synchronous, so the current render's baseDir and source live here
let currentBase: string | undefined;
let currentSrc: string | undefined;
let currentNoHtml = false;
const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

marked.use({
  gfm: true,
  renderer: {
    image(href: string, _title: string | null, text: string) {
      const src = escAttr(fileUrl(href, currentBase, currentSrc));
      if (VIDEO.test(href)) return `<video controls preload="metadata" src="${src}"></video>`;
      if (AUDIO.test(href)) return `<audio controls src="${src}"></audio>`;
      return `<img src="${src}" alt="${escAttr(text || '')}">`;
    },
    // what a person typed (user messages, comments): `<Composer>` is text, not a tag the sanitizer would drop
    html(html: string) {
      return currentNoHtml ? escHtml(html) : html;
    },
    // <input> is forbidden by the sanitizer: a task-list box is a CSS-drawn span (no text, so anchors read the same)
    checkbox(checked: boolean) {
      return `<span class="task-box${checked ? ' checked' : ''}" aria-hidden="true"></span> `;
    },
  },
});

/** A stable React key per media element, so a re-collect of the same wrappers keeps their players mounted. */
let playerSeq = 0;
const playerIds = new WeakMap<Element, number>();
const playerId = (m: Element) => { let n = playerIds.get(m); if (!n) playerIds.set(m, (n = ++playerSeq)); return n; };

/**
 * Video and audio get a wrapper (the host of our player bar); project media (src is a /file URL; not /attach, not http)
 * also gets an "open in a tab" button. Once per element.
 */
function addMediaButtons(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('img, video, audio').forEach((m) => {
    if (m.parentElement?.classList.contains('md-media')) return;
    const f = fileOfImage(m);
    // `![](/attach/<id>)` also renders as a /file URL (an absolute path): it is a pasted image, not a project file
    const project = !!f && !f.path.startsWith('/attach/');
    if (!project && m instanceof HTMLImageElement) return;
    const wrap = document.createElement('span');
    wrap.className = 'md-media';
    m.replaceWith(wrap);
    wrap.appendChild(m);
    if (!project) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'md-open-media';
    b.textContent = '⤢';
    b.setAttribute('data-anchor-skip', '');
    b.setAttribute('aria-label', t('openInTab'));
    b.title = t('openInTab');
    wrap.appendChild(b);
  });
}

/** A colour as written in CSS: hex, or a colour function. Named colours are left alone (`red` is as often a word). */
const COLOUR = /^(?:#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\))$/i;

/** Inline code that is a colour shows a swatch of it, as IntelliJ does; drawn by CSS, so the text stays as written. */
function markColours(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>(':not(pre) > code').forEach((c) => {
    const v = c.textContent?.trim() ?? '';
    if (!COLOUR.test(v) || (typeof CSS !== 'undefined' && CSS.supports && !CSS.supports('color', v))) return;
    c.classList.add('md-color');
    c.style.setProperty('--md-swatch', v);
  });
}

/** A row label up to this many characters (graphemes) does not wrap. */
const SHORT_CELL = 24;
/** Text written without spaces between words (CJK): wrapping there is between any characters, no phrase to keep whole. */
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter() : null;
const length = (s: string) => (graphemes ? [...graphemes.segment(s)].length : [...s].length);

/**
 * Each table goes into a box that scrolls sideways when the table is wider than the message (issue 453), and the short
 * row labels of its first column are marked to stay on one line. Once per table: a wrapped one is skipped.
 */
function wrapTables(root: HTMLElement) {
  root.querySelectorAll<HTMLTableElement>('table').forEach((tb) => {
    if (tb.parentElement?.classList.contains('md-table')) return;
    const box = document.createElement('div');
    box.className = 'md-table';
    tb.replaceWith(box);
    box.appendChild(tb);
    for (const row of tb.rows) {
      const c = row.cells[0];
      const s = c?.textContent?.trim() ?? '';
      if (c && s && length(s) <= SHORT_CELL && !NO_SPACES.test(s) && !c.querySelector('img, video, audio, pre')) c.classList.add('md-cell-short');
    }
  });
}

/** `blocks`: the code blocks the plugins draw (none when no plugin draws them), `d` the store's dispatch. */
function postProcess(root: HTMLElement, final: boolean, blocks?: ReadonlyMap<string, CodeBlock>, d?: AppDispatch) {
  wrapTables(root);
  if (final) addMediaButtons(root);
  markColours(root);
  root.querySelectorAll<HTMLElement>('pre code').forEach((c) => {
    const lang = /language-(\w+)/.exec(c.className)?.[1];
    const pre = c.parentElement!;
    const block = final && lang ? blocks?.get(lang) : undefined;
    if (block && d) {
      const out = document.createElement('div');
      out.className = block.className;
      pre.replaceWith(out);
      block.draw(out, c.textContent ?? '', d);
    } else if (!c.dataset.highlighted) {
      hljs.highlightElement(c);
      c.dataset.highlighted = 'yes';
      numberLines(c);
      addCopyButton(pre);
    }
  });
}

export const Markdown = memo(
  /**
   * `src`: the source of the file being shown (M3-16): its relative images load from that source.
   * `breaks`: a single newline is a line break (what the user typed in the composer). `mentions`: `@path` in the text
   * becomes a clickable ref (user messages; the text must have gone through `escapeMentions`). `noHtml`: raw HTML in
   * the text is shown as typed (what a person wrote: `<Tag>` stays visible), not passed to the sanitizer.
   */
  function Markdown({ text, final, baseDir, src, breaks, mentions, noHtml }: { text: string; final: boolean; baseDir?: string; src?: string; breaks?: boolean; mentions?: boolean; noHtml?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const store = useStore() as AppStore;
    const reg = registry(store);
    const Player = reg.media?.ChatPlayer;
    // absolute paths become refs only inside a known source's dir: re-mark when the list arrives or changes
    const sources = useSources();
    const tmpDirs = useAppSelector(selectTmpDirs); // likewise a temp folder's images
    const html = useMemo(
      () => {
        currentBase = baseDir;
        currentSrc = src;
        currentNoHtml = !!noHtml;
        try {
          return DOMPurify.sanitize(marked.parse(text, { async: false, breaks }) as string, {
            ADD_TAGS: ['video', 'audio'],
            ADD_ATTR: ['controls', 'preload'],
            ...HARDEN,
          });
        } finally {
          currentBase = undefined;
          currentSrc = undefined;
          currentNoHtml = false;
        }
      },
      [text, baseDir, src, breaks, noHtml],
    );
    useLayoutEffect(() => {
      if (!ref.current || !final) return;
      markRefs(ref.current, baseDir, tmpDirs);
      if (mentions) markMentions(ref.current);
    }, [html, final, baseDir, sources, tmpDirs, mentions]);
    // the wrappers of the reply's video/audio, each hosting our player bar (without the media plugin: native controls stay)
    const [players, setPlayers] = useState<{ media: HTMLMediaElement; box: HTMLElement }[]>([]);
    useLayoutEffect(() => {
      if (!ref.current) return;
      postProcess(ref.current, final, reg.codeBlocks, store.dispatch);
      if (!final || !Player) return setPlayers((p) => (p.length ? [] : p));
      setPlayers(Array.from(ref.current.querySelectorAll<HTMLMediaElement>('.md-media > video, .md-media > audio'), (media) => ({ media, box: media.parentElement! })));
    }, [html, final, reg, store, Player]);
    useEffect(() => theme.subscribe(() => {
      if (!ref.current) return;
      for (const b of reg.codeBlocks.values()) b.retheme?.(ref.current, store.dispatch);
    }), [reg, store]);
    const onClick = (e: ReactMouseEvent<HTMLDivElement>) => {
      const cb = (e.target as Element).closest('button.md-copy-code');
      if (cb && e.currentTarget.contains(cb)) {
        copyCode(cb).catch(() => toast(t('codeCopyFail'), ''));
        return;
      }
      const mb = (e.target as Element).closest('button.md-open-media');
      if (mb && e.currentTarget.contains(mb)) {
        // inside a link or a ref, the click must not navigate or open a second time
        e.preventDefault();
        e.stopPropagation();
        const m = mb.parentElement?.querySelector('img, video, audio');
        const open = m && openMediaFile(m);
        if (!open) return;
        // a played video/audio opens at that time, a playing one plays on (consumed once by the file view, see refs/startAt.ts)
        if (m instanceof HTMLMediaElement && m.currentTime > 0) {
          const f = fileOfImage(m)!;
          setStartAt(fileTabId(f.path, f.src), m.currentTime, !m.paused && !m.ended);
        }
        store.dispatch(open);
        return;
      }
    };
    return (
      <>
        <div ref={ref} className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
        {Player && players.map((p) => createPortal(<Player media={p.media} box={p.box} />, p.box, String(playerId(p.media))))}
      </>
    );
  },
  (a, b) => a.text === b.text && a.final === b.final && a.baseDir === b.baseDir && a.src === b.src && a.breaks === b.breaks && a.mentions === b.mentions && a.noHtml === b.noHtml,
);
