import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { de } from './de.ts';
import { en } from './en.ts';
import { es } from './es.ts';
import { ptBR } from './pt-BR.ts';
import { ru } from './ru.ts';
import { zhCN } from './zh-CN.ts';

/**
 * A tooltip names the action, plus its key or slash command (issue 463): no longer than this in any language. The
 * explanations live in the help dictionary (./help), which the in-app reference shows (issue 464).
 */
const LIMIT = 50;

const DICTS = { en, ru, 'zh-CN': zhCN, es, 'pt-BR': ptBR, de } as Record<string, Record<string, unknown>>;
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Tooltip keys that reach a `title` or a tooltip through a variable or a helper's argument, so the source scan below
 * cannot see them (the editor's tool buttons, the track head, the meter, the idle-compaction note, the export's reason).
 */
const INDIRECT = [
  'cutToolSelect', 'cutToolBlade', 'cutUndo', 'cutRedo', 'cutSplit', 'cutDuplicate', 'cutDelete', 'cutComment',
  'cutTrackMute', 'cutTrackSolo', 'cutTrackHide', 'cutTrackUp', 'cutTrackDown', 'cutTrackRemove', 'cutClipOn', 'cutClipOff',
  'idleBlocked', 'cutExportBlocked', 'cutTrimStart', 'cutTrimEnd',
];

/** Tooltips that may be longer, each with its reason. */
const ALLOW: Record<string, string> = {
  keysTip: "the composer's \"?\": its tooltip is the list of the keys, one per line",
  usageModelTip: "a data readout, not an explanation: the model's four counts, each with its name",
  editTip: "a comment card's \"?\" while editing: the list of its keys, one per line",
};

/** the expression that opens at `i` (`{` or `(`), with its nested brackets */
function grab(s: string, i: number): string {
  const open = s[i]!;
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return s.slice(i, j + 1);
  }
  return '';
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'i18n' ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
}

/**
 * Which strings are tooltips: every dictionary key quoted inside a `title={…}`, `tip={…}` or `label={…}` attribute, a
 * `<TooltipContent>` or a `withKey(…)`/`withKeys(…)` call anywhere in the web source; every key named `…Tip` or
 * `…Tip<Variant>` (the naming convention); and INDIRECT.
 */
function tooltipKeys(): Set<string> {
  const keys = new Set<string>(INDIRECT);
  const pick = (expr: string) => { for (const m of expr.matchAll(/'(\w+)'/g)) if (m[1]! in en) keys.add(m[1]!); };
  for (const f of sources(SRC)) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/(?<![\w-])(?:title|tip|label)=\{/g)) pick(grab(s, m.index + m[0].length - 1));
    for (const m of s.matchAll(/<TooltipContent\b/g)) pick(s.slice(m.index, s.indexOf('</TooltipContent>', m.index)));
    for (const m of s.matchAll(/\bwithKeys?\(/g)) pick(grab(s, m.index + m[0].length - 1));
  }
  for (const k of Object.keys(en)) if (/Tip(?:[A-Z]\w*)?$/.test(k)) keys.add(k);
  return keys;
}

/** a string as shown, its parameters filled with one character each */
const shown = (v: unknown): string => (typeof v === 'function' ? String(v(...Array(6).fill('9'))) : String(v));

it('the scan finds the tooltips it should (a sanity check of the scan itself)', () => {
  const keys = tooltipKeys();
  for (const k of ['compactTip', 'clearTip', 'restartTip', 'sessTip', 'ctxTip', 'cutToolSelect', 'attach', 'modelTip', 'openRawTip']) expect(keys).toContain(k);
  for (const k of Object.keys(ALLOW)) expect(keys).toContain(k);
});

it('the allow-list holds only tooltips that need it', () => {
  expect(Object.keys(ALLOW).filter((k) => Object.values(DICTS).every((d) => shown(d[k]).length <= LIMIT))).toEqual([]);
});

it.each(Object.keys(DICTS))(`%s: every tooltip is at most ${LIMIT} characters (the action's name, its key or command)`, (lang) => {
  const dict = DICTS[lang]!;
  const long = [...tooltipKeys()].filter((k) => !(k in ALLOW)).map((k) => [k, shown(dict[k])] as const).filter(([, s]) => s.length > LIMIT);
  expect(long.map(([k, s]) => `${k} (${s.length}): ${s}`)).toEqual([]);
});
