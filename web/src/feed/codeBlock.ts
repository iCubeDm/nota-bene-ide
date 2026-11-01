import { t } from '@/i18n/index.ts';

const COPY_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>';
const DONE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m3 8.5 3.5 3.5L13 4.5"/></svg>';
const DONE_MS = 1200;

/**
 * One block per source line, so a line that wraps keeps one number (markdown.css draws them with a counter: no text in the
 * DOM, so selection, copying and comment anchors read the code as it was). A highlighted token spanning lines is reopened
 * on each. The newlines stay in the text. A single line gets nothing: a lone number says nothing.
 */
export function numberLines(code: HTMLElement): void {
  const line = () => { const s = document.createElement('span'); s.className = 'md-line'; return s; };
  const lines = [line()];
  const open: Element[] = []; // the tokens around the point being copied
  let tip: Node = lines[0]!;
  const visit = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      (n.nodeValue ?? '').split('\n').forEach((part, i) => {
        if (i) {
          tip.appendChild(document.createTextNode('\n'));
          lines.push(tip = line());
          for (const e of open) tip = tip.appendChild(e.cloneNode(false));
        }
        if (part) tip.appendChild(document.createTextNode(part));
      });
    } else if (n instanceof Element) {
      tip = tip.appendChild(n.cloneNode(false));
      open.push(n);
      n.childNodes.forEach(visit);
      open.pop();
      tip = tip.parentNode!;
    }
  };
  code.childNodes.forEach(visit);
  if (!lines.at(-1)!.textContent) lines.pop(); // the newline that ends the last line starts no new one
  if (lines.length < 2) return;
  code.style.setProperty('--md-digits', String(String(lines.length).length));
  code.replaceChildren(...lines);
}

/** The copy button of a code block, skipped by comment anchors (markdown.css places it). */
export function addCopyButton(pre: HTMLElement): void {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'md-copy-code';
  b.innerHTML = COPY_ICON;
  b.setAttribute('data-anchor-skip', '');
  b.setAttribute('aria-label', t('codeCopy'));
  b.title = t('codeCopy');
  pre.appendChild(b);
}

/** Puts the block's code on the clipboard; the button answers with a tick. Rejects when the browser refuses. */
export async function copyCode(b: Element): Promise<void> {
  const text = b.parentElement?.querySelector('code')?.textContent ?? '';
  await navigator.clipboard.writeText(text.replace(/\n$/, ''));
  b.innerHTML = DONE_ICON;
  b.setAttribute('aria-label', t('codeCopied'));
  (b as HTMLElement).title = t('codeCopied');
  setTimeout(() => {
    b.innerHTML = COPY_ICON;
    b.setAttribute('aria-label', t('codeCopy'));
    (b as HTMLElement).title = t('codeCopy');
  }, DONE_MS);
}
