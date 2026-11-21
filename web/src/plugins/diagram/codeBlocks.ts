import { t, theme, openDiagram, type AppDispatch, type CodeBlock, type DiagramLang } from '@/sdk';
import { renderMermaid, sanitizeSvg } from './render.ts';

/**
 * The ⤢ button, made after sanitizing and skipped by comment anchors; shown on hover (markdown.css). Its source and
 * language live in its listener, not in the DOM: sanitized content must not be able to forge one.
 */
function addOpenButton(out: HTMLElement, source: string, lang: DiagramLang, d: AppDispatch) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'md-open-diagram';
  b.textContent = '⤢';
  b.setAttribute('data-anchor-skip', '');
  b.setAttribute('aria-label', t('openDiagram'));
  b.title = t('openDiagram');
  const open = { source: source.replace(/\s+$/, ''), lang };
  b.addEventListener('click', () => void d(openDiagram(open)));
  out.appendChild(b);
}

/** The source and theme kind of every mermaid drawing in the chat: a theme switch draws again the ones of the other kind. */
const mermaidBlocks = new WeakMap<HTMLElement, { code: string; kind: 'dark' | 'light' }>();

function drawMermaid(out: HTMLElement, code: string, d: AppDispatch) {
  const kind = theme.kind();
  mermaidBlocks.set(out, { code, kind });
  void renderMermaid(code).then((r) => {
    if (mermaidBlocks.get(out)?.kind !== kind) return; // a newer drawing owns the block
    if ('svg' in r) {
      out.innerHTML = r.svg;
      addOpenButton(out, code, 'mermaid', d);
    } else out.textContent = r.error;
  });
}

/** A reply's ```mermaid and ```svg blocks are drawn, each with its ⤢ to open it in a diagram tab (issue 545: registered, Markdown is core). */
export const DIAGRAM_BLOCKS: CodeBlock[] = [
  {
    lang: 'mermaid', className: 'mermaid-out', draw: drawMermaid,
    retheme: (root, d) => root.querySelectorAll<HTMLElement>('.mermaid-out').forEach((out) => {
      const b = mermaidBlocks.get(out);
      if (b && b.kind !== theme.kind()) drawMermaid(out, b.code, d);
    }),
  },
  {
    lang: 'svg', className: 'svg-out',
    draw: (out, code, d) => {
      out.innerHTML = sanitizeSvg(code);
      addOpenButton(out, code, 'svg', d);
    },
  },
];
