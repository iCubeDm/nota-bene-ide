import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

// jsdom computes no layout: the content widths are checked in e2e/files.spec.ts, on real layout
const css = readFileSync(resolve(__dirname, 'theme.css'), 'utf8');
const rule = (sel: string) => new RegExp(`${sel.replace(/[.:()[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

it('media fits the pane and the natural size lifts the limits', () => {
  expect(rule('.nb-fit')).toMatch(/max-width: 100%;.*max-height: calc\(100% - 2rem\);.*object-fit: contain/s);
  expect(rule('.nb-media-pane.nb-natural .nb-fit')).toContain('max-width: none');
});

/** The theme files: the only places a colour value may be written. */
const THEME_FILES = new Set(['theme.css', 'feed/hljs.css', 'fonts.css']);

const PALETTE = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const LITERAL = new RegExp(
  String.raw`#[0-9a-fA-F]{3,8}\b|\boklch\(|\brgba?\(|\bhsla?\(|` +
  String.raw`\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|shadow|decoration|accent|caret)-(?:white|black|(?:${PALETTE})-\d{2,3})\b`,
  'g',
);

/**
 * Colours that are the same in every theme, by file and literal. The markup colours are what the agent sees on the
 * frame (the shared MARK_COLORS table, and the discs, halo and swatch ring drawn around them); white text on a coloured
 * button; the favicon and the canvas fallback of the 3D view.
 */
const ALLOWED: Record<string, string[] | '*'> = {
  'shell/Favicon.ts': '*',
  'media/markup/badges.ts': ['#ffffff', '#111111'],
  'media/markup/render.ts': ['#ffffff'],
  'media/markup/overlay.tsx': ['rgba('],
  'media/markup/MarkupToolbar.tsx': ['border-black'],
  'components/ui/button.tsx': ['text-white'],
  'model/viewer.ts': ['#202020'],
};

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.(ts|tsx|css)$/.test(e.name) && !/\.test\./.test(e.name)) yield p;
  }
}

it('no colour literal outside the theme files', () => {
  const found: string[] = [];
  for (const abs of sources(__dirname)) {
    const file = relative(__dirname, abs).replaceAll('\\', '/');
    if (THEME_FILES.has(file)) continue;
    const allowed = ALLOWED[file];
    if (allowed === '*') continue;
    readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
      for (const [lit] of line.matchAll(LITERAL)) {
        if (allowed?.includes(lit)) continue;
        found.push(`${file}:${i + 1} ${lit}`);
      }
    });
  }
  expect(found).toEqual([]);
});

/** The custom properties a theme block declares, by its selector as written in theme.css. */
function themeVars(selector: string): Set<string> {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no block "${selector}" in theme.css`).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
}

it('every theme defines every token', () => {
  const plannotator = themeVars('[data-theme="plannotator"]');
  const darcula = themeVars(':root, [data-theme="darcula"]');
  expect(plannotator.size).toBeGreaterThan(40);
  expect([...darcula].sort()).toEqual([...plannotator].sort());
});
