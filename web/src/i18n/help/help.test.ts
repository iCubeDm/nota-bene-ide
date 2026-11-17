import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { LANGS } from '../index.ts';
import { HELP, HELP_ENTRIES } from './index.ts';

const GUIDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/guide.md');

/** a heading's anchor as GitHub makes it: lower case, punctuation dropped, spaces to hyphens */
const slug = (h: string) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');

it.each(LANGS.map((l) => l.id))('%s has every help entry, none empty', (lang) => {
  const dict = HELP[lang];
  expect(Object.keys(dict).sort()).toEqual(Object.keys(HELP_ENTRIES).sort());
  expect(Object.entries(dict).filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
});

it('every entry links to a heading of the guide', () => {
  const anchors = new Set([...fs.readFileSync(GUIDE, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!)));
  expect(Object.entries(HELP_ENTRIES).filter(([, e]) => !anchors.has(e.guide)).map(([k, e]) => `${k}: #${e.guide}`)).toEqual([]);
});
