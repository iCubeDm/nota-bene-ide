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
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Tooltip keys that reach a `title` or a tooltip through a variable or a helper's argument, so the source scan below
 * cannot see them (the editor's tool buttons, the track head, the meter, the idle-compaction note, the export's reason, the
 * markup tools).
 */
const INDIRECT = [
  'cutToolSelect', 'cutToolBlade', 'cutUndo', 'cutRedo', 'cutSplit', 'cutDuplicate', 'cutDelete', 'cutComment',
  'cutTrackMute', 'cutTrackSolo', 'cutTrackHide', 'cutTrackUp', 'cutTrackDown', 'cutTrackRemove', 'cutClipOn', 'cutClipOff',
  'idleBlocked', 'cutExportBlocked', 'toolRect', 'toolEllipse', 'toolPen', 'toolArrow', 'toolMask',
  'h5Tip', 'weekTip', 'pb_mute', 'pb_unmute',
];

/** Keys the scan finds that are no tooltip, each with what it is. */
const NOT_TOOLTIP: Record<string, string> = {
  openQ: "a confirm dialog's heading (its `title` prop)",
  newQ: "a confirm dialog's heading (its `title` prop)",
  deleteQ: "a confirm dialog's heading (its `title` prop)",
  projStopQ: "a confirm dialog's heading (its `title` prop)",
  compacting: 'the compaction line: shown as text, its aria-label repeats it',
  projSessionsOf: "a group's accessible name, never shown",
};

/**
 * Realistic parameters of every parametrised tooltip, per language (both branches of a boolean or a plural): a string is
 * measured as the user sees it, not with one-character stand-ins.
 */
const SAMPLES: Record<string, (lang: string) => unknown[][]> = {
  markAttachmentN: () => [[1], [12]],
  uploadCancel: () => [['screenshot.png']],
  keysTip: () => [['Ctrl+']],
  attach: () => [['Ctrl+'], ['⌘']],
  cutRemovedClip: () => [['media/intro.mp4']],
  cutZoomOut: () => [['Ctrl'], ['⌘']],
  cutZoomIn: () => [['Ctrl'], ['⌘']],
  pb_comments: () => [[1], [12]],
  markColor: () => [[1], [2], [3], [4], [5]],
  markUndo: () => [[true], [false]],
  projUnseenTip: () => [[3]],
  helpersOf: () => [[1], [4]],
  projStop: () => [['my-project']],
  projExpand: () => [['my-project']],
  projForget: () => [['my-project']],
  vcsAgainst: () => [['feature/login']],
  vcsSwitchTip: () => [['feature/login']],
  vcsOpenTreeTip: () => [['feature/login']],
  updateTitle: () => [['2.10.1']],
  commentsN: () => [[12]],
  updateReloadTip: () => [['2.10.1']],
  updatedTo: () => [['2.10.1']],
  ctxNudge: () => [[85]],
  ctxTip: () => [['123.4k', '200k']],
  usageTotalsTip: (l) => [l === 'ru' ? ['9.9 млрд', '9.9 млн'] : ['9.9B', '9.9M']],
  usageModelTip: (l) => [l === 'ru' ? ['1234', '9.9 млн', '9.9 млн', '9.9 млрд'] : ['1234', '9.9M', '9.9M', '9.9B']],
  voiceLangDetected: () => [['Português']],
  idleTip: () => [[true, 50], [false, 50]],
  voiceSendTip: () => [['Alt+R'], ['⌥R']],
  voiceSendBusyTip: () => [['Alt+R', 'Ctrl+Enter'], ['⌥R', '⌘Enter']],
};

/** Tooltips put together from several strings, as the component shows them (the meters: the limit and when it resets). */
const JOINED: Record<string, (d: typeof en) => string> = {
  h5Reset: (d) => `${d.h5Tip} · ${d.resets('Mon, 14:00')}`,
  weekReset: (d) => `${d.weekTip} · ${d.resets('Mon, 14:00')}`,
};

/** Tooltips that may be longer, each with its reason. */
const ALLOW: Record<string, string> = {
  dictUse: "a settings checkbox's accessible name, the same as its visible label beside it: no tooltip",
  defSoundAsk: "a settings row's visible label, also in its Try button's accessible name: no tooltip",
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
    for (const m of s.matchAll(/(?<![\w-])(?:title|tip|label|aria-label)=\{/g)) pick(grab(s, m.index + m[0].length - 1));
    for (const m of s.matchAll(/<TooltipContent\b/g)) pick(s.slice(m.index, s.indexOf('</TooltipContent>', m.index)));
    for (const m of s.matchAll(/\bwithKeys?\(/g)) pick(grab(s, m.index + m[0].length - 1));
  }
  for (const k of Object.keys(en)) if (/Tip(?:[A-Z]\w*)?$/.test(k)) keys.add(k);
  for (const k of Object.keys(NOT_TOOLTIP)) keys.delete(k);
  return keys;
}

/** a string as shown: a parametrised one with each of its SAMPLES */
const shown = (lang: string, k: string): string[] => {
  const v = DICTS[lang]![k];
  return typeof v === 'function' ? (SAMPLES[k]?.(lang) ?? [[]]).map((args) => String(v(...args))) : [String(v)];
};

it('the scan finds the tooltips it should (a sanity check of the scan itself)', () => {
  const keys = tooltipKeys();
  for (const k of ['compactTip', 'clearTip', 'restartTip', 'vcsTip', 'ctxTip', 'cutToolSelect', 'attach', 'modelTip', 'openRawTip']) expect(keys).toContain(k);
  for (const k of Object.keys(ALLOW)) expect(keys).toContain(k);
});

it('the allow-list holds only tooltips that need it', () => {
  expect(Object.keys(ALLOW).filter((k) => Object.keys(DICTS).every((l) => shown(l, k).every((s) => s.length <= LIMIT)))).toEqual([]);
});

it('every parametrised tooltip has realistic samples', () => {
  expect([...tooltipKeys()].filter((k) => typeof (en as Record<string, unknown>)[k] === 'function' && !SAMPLES[k])).toEqual([]);
});

it.each(Object.keys(DICTS))(`%s: every tooltip is at most ${LIMIT} characters (the action's name, its key or command)`, (lang) => {
  const long = [
    ...[...tooltipKeys()].filter((k) => !(k in ALLOW)).flatMap((k) => shown(lang, k).map((s) => [k, s] as const)),
    ...Object.entries(JOINED).map(([k, f]) => [k, f(DICTS[lang] as typeof en)] as const),
  ].filter(([, s]) => s.length > LIMIT);
  expect(long.map(([k, s]) => `${k} (${s.length}): ${s}`)).toEqual([]);
});
