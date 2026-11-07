import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { THEMES, THEME_KIND, type ThemeId } from '@nota-bene/shared';

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
 * frame (the shared MARK_COLORS table, and the discs, halo and swatch ring drawn around them); the
 * favicon and the canvas fallback of the 3D view.
 */
const ALLOWED: Record<string, string[] | '*'> = {
  'shell/Favicon.ts': '*',
  'media/markup/badges.ts': ['#ffffff', '#111111'],
  'media/markup/render.ts': ['#ffffff'],
  'media/markup/overlay.tsx': ['rgba('],
  'media/markup/MarkupToolbar.tsx': ['border-black'],
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

/** A theme block's selector as theme.css writes it. */
const themeSelector = (id: ThemeId) => (id === 'darcula' ? ':root, [data-theme="darcula"]' : `[data-theme="${id}"]`);
const blockBody = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
};

it('every theme defines every token', () => {
  const plannotator = themeVars(themeSelector('plannotator'));
  expect(plannotator.size).toBeGreaterThan(40);
  for (const id of THEMES) expect([...themeVars(themeSelector(id))].sort(), id).toEqual([...plannotator].sort());
});

it('a light theme says so to the browser', () => {
  for (const id of THEMES) {
    const scheme = /color-scheme\s*:\s*([\w ]+);/.exec(blockBody(themeSelector(id)))?.[1];
    if (THEME_KIND[id] === 'light') expect(scheme, id).toBe('light');
    else expect(scheme, id).toBeUndefined();
  }
});

it('dark: variants only apply to dark themes', () => {
  const variant = /@custom-variant dark\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  expect(variant).toContain('prefers-color-scheme: dark');
  expect(variant).toContain(':not([data-theme$="-light"])');
  expect(variant).toContain('@slot');
});

it('the inline script knows every theme', () => {
  const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
  const list = /var ids = \[([^\]]*)\]/.exec(html)?.[1] ?? '';
  expect([...list.matchAll(/'([\w-]+)'/g)].map((m) => m[1])).toEqual([...THEMES]);
});

/** A theme block's declarations, `var()` resolved within the block. Colours: hex and `rgb()` only. */
function themeTokens(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  const out: Record<string, string> = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

type RGB = [number, number, number];
function parseColour(v: string, tokens: Record<string, string>): RGB {
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return parseColour(tokens[ref[1]!]!, tokens);
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as RGB;
  const rgb = /^rgb\((\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+))?\)$/.exec(v);
  if (rgb) {
    const c = [rgb[1], rgb[2], rgb[3]].map(Number) as RGB;
    const a = rgb[4] === undefined ? 1 : Number(rgb[4]);
    if (a === 1) return c;
    // a translucent colour is seen over the window's background
    const bg = parseColour(tokens['--background']!, tokens);
    return c.map((x, i) => x * a + bg[i]! * (1 - a)) as RGB;
  }
  throw new Error(`not a hex or rgb() colour: ${v}`);
}

/** WCAG 2 relative luminance and contrast ratio. */
const luminance = ([r, g, b]: RGB) => {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

/** The pairs every theme's text and controls must keep at 4.5:1 (the outlines have their own thresholds below). */
const AA_PAIRS: [string, string][] = [
  ['--foreground', '--background'], ['--foreground', '--card'], ['--foreground', '--popover'],
  ['--muted-fg', '--card'], ['--muted-fg', '--muted'], ['--muted-fg', '--popover'], ['--muted-fg', '--side'],
  ['--primary-fg', '--primary'], ['--tab-on-fg', '--tab-on-bg'], ['--tool-on-fg', '--tool-on'],
  ['--tool-on-idle-fg', '--tool-on-idle'], ['--link', '--card'], ['--link', '--popover'],
  ['--destructive', '--card'], ['--destructive-fg', '--destructive'], ['--destructive-fg', '--destructive-fill'], ['--code-inline-fg', '--code-inline-bg'],
  ['--accent-sessions', '--chrome'], ['--accent-agent', '--chrome'], ['--accent-model', '--chrome'],
  ['--accent-usage', '--chrome'], ['--meter-fg', '--chrome'], ['--destructive', '--chrome'],
  // code: every syntax colour on the code block
  ...['text', 'keyword', 'string', 'function', 'number', 'comment', 'type', 'variable', 'property', 'param', 'builtin',
    'tag', 'section', 'bullet'].map((s): [string, string] => [`--syn-${s}`, '--syn-bg']),
  ['--syn-add', '--syn-add-bg'], ['--syn-del', '--syn-del-bg'],
  // file-type letters and the mode pills' text, on the card and the side panels
  ...[1, 2, 3, 4, 5, 6, 7, 8, 17, 19].flatMap((n): [string, string][] => [[`--hue-${n}`, '--card'], [`--hue-${n}`, '--side']]),
];

it.each(THEMES.filter((id) => id !== 'plannotator'))('%s passes AA', (id) => {
  const tk = themeTokens(themeSelector(id));
  const ratio = (fg: string, bg: string) => contrast(parseColour(tk[fg]!, tk), parseColour(tk[bg]!, tk));
  const failing = AA_PAIRS.map(([fg, bg]) => `${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`).filter((_, i) => ratio(...AA_PAIRS[i]!) < 4.5);
  expect(failing).toEqual([]);
  expect(ratio('--border', '--card')).toBeGreaterThanOrEqual(1.5);
  // a meter's outline is the part of the control that has to show (WCAG 1.4.11)
  expect(ratio('--meter-line', '--chrome')).toBeGreaterThanOrEqual(3);
});
