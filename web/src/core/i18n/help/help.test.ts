import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { en } from '../en.ts';
import { LANGS } from '../index.ts';
import { HELP, HELP_ENTRIES } from './index.ts';

const GUIDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../docs/guide.md');

/** a heading's anchor as GitHub makes it: lower case, punctuation dropped, spaces to hyphens */
const slug = (h: string) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');

it.each(LANGS.map((l) => l.id))('%s has every help entry, none empty', (lang) => {
  const dict = HELP[lang];
  expect(Object.keys(dict).sort()).toEqual(Object.keys(HELP_ENTRIES).sort());
  const text = (v: unknown) => (typeof v === 'function' ? String(v('X', 'Y')) : String(v));
  expect(Object.entries(dict).filter(([, v]) => !text(v).trim()).map(([k]) => k)).toEqual([]);
  // a function entry takes its HelpArgs and shows each of them
  expect(Object.entries(dict).filter(([, v]) => typeof v === 'function' && !text(v).includes('X')).map(([k]) => k)).toEqual([]);
});

it('every entry links to a heading of the guide', () => {
  const anchors = new Set([...fs.readFileSync(GUIDE, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!)));
  expect(Object.entries(HELP_ENTRIES).filter(([, e]) => !anchors.has(e.guide)).map(([k, e]) => `${k}: #${e.guide}`)).toEqual([]);
});

it('every tooltip an entry links from is a key of the UI dictionary, and links to one entry only', () => {
  const tips = Object.values(HELP_ENTRIES).flatMap((e) => [...e.tips] as string[]);
  expect(tips.filter((k) => !(k in en))).toEqual([]);
  expect(tips.filter((k, i) => tips.indexOf(k) !== i)).toEqual([]);
});
