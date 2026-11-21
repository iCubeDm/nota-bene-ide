// The import rule of issue 511 (docs/superpowers/specs/2026-11-20-core-plugins-design.md, "The import rule"):
// plugins import only the SDK, core imports no plugin, `@/testing` is test-only, plus three text rules. Issue 545 emptied
// the baseline the rule started with (step 1 of issue 511), so the tree has no violation and none may come back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

const REPO = path.resolve(import.meta.dirname, '..');

// A file's role is its directory (issue 570): `web/src/core/<name>/` is the core, `web/src/plugins/<name>/` a plugin,
// `core/testing/` the harness, a file at `web/src/` the composition root. Any other folder fails the scan.
const HARNESS = 'testing'; // test-only code, importable from tests only
const SDK = ['core/sdk/index.ts', 'core/sdk/ui.ts'];
// shared test setups outside the harness, held to the test files' rules
const TEST_HELPERS = ['plugins/cut/testCut.tsx'];
// The module singletons kept outside the store by design (issue 545, the spec's As built 50), each read with `useStored`.
// Any other value with its own listeners outside the SDK is a module singleton the state rule puts in a slice,
// `useResource` or `storage`: the check counts a `useStored({ … })` read and a module-level listener set.
const SINGLETONS: Record<string, string> = {
  // ticks with a media element: through Redux it would re-render the store's readers at frame rate
  'plugins/cut/Meter.tsx': "the edit player's state",
  'plugins/cut/Timeline.tsx': "the edit player's clock",
  'plugins/cut/CutBody.tsx': "the edit's reversed copies, made as it plays",
  'plugins/voice/player.ts': "the voice bubbles' playback position",
  'core/tabs/TabStrip.tsx': "the media controller's playing tab",
  // live objects of mounted views (callbacks, the open edits), not data a reducer can hold
  'plugins/cut/live.ts': 'the edits open in a tab',
  'plugins/cut/targets.ts': 'the open edits "Add to edit" can add to',
  // called where no store is in reach (a fetch catch, a middleware), transient, never replayed
  'core/shell/toast.ts': 'the toasts',
  'core/shell/Toasts.tsx': 'the toasts',
  // HTTP data, yet not a resource: it loads on demand (a root change, the tree opening, a refresh) with a 5 s
  // time-to-live, and a forced load drops an answer still in flight; the repository has watches and polls, no TTL for a
  // load, and pauses its reads while the page is hidden. Folding it needs that option in the repository first
  'core/refs/sources.ts': 'the sources',
  // browser values, not app state
  'plugins/feed/time.ts': 'the local day, moved at midnight',
  'plugins/feed/MsgTime.tsx': 'the local day',
  'plugins/projects/ProjectRail.tsx': 'the width media query',
  'core/anchors/frame.ts': "the page frames' render count",
};
const WEB = 'web/src';
const PHONE = 'mobile/app/lib';

// Comments become a space and every string literal a numbered placeholder "<n>", so a specifier inside a string or a
// comment is never seen as an import and the import patterns below match only real code. Templates vanish entirely,
// so an `import('…')` inside a `${}` interpolation is not seen.
const LEXEMES = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`/g;
function mask(text: string): { code: string; strings: string[] } {
  const strings: string[] = [];
  const code = text.replace(LEXEMES, (m) => {
    if (m[0] === '/') return ' ';
    if (m[0] === '`') return '``';
    strings.push(m.slice(1, -1));
    return `"${strings.length - 1}"`;
  });
  return { code, strings };
}

const S = String.raw`"(\d+)"`;
const IMPORTS = new RegExp(
  [
    String.raw`(?<![\w$.])import\s+(?:type\s+)?[\w$*{},\s]+?\s+from\s*${S}`, // import a, { b } from / import type
    String.raw`(?<![\w$.])export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*${S}`, // export … from
    String.raw`(?<![\w$.])import\s*${S}`, // side effect
    String.raw`(?<![\w$.])import\s*\(\s*${S}\s*\)`, // dynamic
  ].join('|'),
  'g',
);
// A protocol gate: any relational comparison of `protocol` (also `(x.protocol ?? 0)`) or against a protocol constant
// (`*_PROTOCOL`, Dart `*Protocol`). Issue 511 replaces them all with named features.
const GATE = /\bprotocol\b\s*(?:\?\?\s*0\s*\)\s*)?[<>]=?(?![=>])|[<>]=?\s*\(?\s*\w*(?:_PROTOCOL|Protocol)\b/;

// A value with its own listeners: read through `useStored({ … })`, or a listener set at module level.
const singleton = (code: string): boolean => /\buseStored\(\s*\{/.test(code) || /^(?:const|let) [\w$]+ = new Set<\(\) => void>\(\)/m.test(code);

function files(dir: string, ext: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => ext.test(f)).map((f) => path.join(dir, f));
}

// `@/x` and `./x` to a web/src-relative file; a package or an unresolvable path returns undefined.
function resolve(from: string, spec: string, src: string): string | undefined {
  spec = spec.replace(/\?.*$/, '');
  // `@/sdk` is an alias of the core's SDK folder (web/vite.config.ts, web/tsconfig.json)
  if (/^@\/sdk(?:\/|$)/.test(spec)) spec = `@/core/${spec.slice(2)}`;
  const abs = spec.startsWith('@/') ? path.join(src, spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : undefined;
  if (!abs) return undefined;
  const hit = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map((e) => abs + e).find((p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile());
  return path.relative(src, hit ?? abs).split(path.sep).join('/');
}

type Role = 'core' | 'plugin' | 'root' | 'harness';
function role(rel: string): { role: Role; folder: string } {
  const [part, folder, more] = rel.split('/');
  if (folder === undefined) return { role: 'root', folder: '' };
  if (more !== undefined && part === 'core') return { role: folder === HARNESS ? 'harness' : 'core', folder };
  if (more !== undefined && part === 'plugins') return { role: 'plugin', folder };
  throw new Error(`boundaries: web/src/${part}/ is neither core/<name>/ nor plugins/<name>/`);
}

// The state rule of issue 563: a plugin's slice is read only inside that plugin; the core's slices are anyone's
// (directly or through the SDK's selectors), and another plugin's state comes through its service. A slice's owner is
// the folder of its `createSlice({ name })`; a read is `s.<name>` or `s['<name>']` (also `st`, `state`, `was`,
// `getState()`), or a destructured `{ <name> }` of the state: a selector's parameter, one typed `RootState`, or one
// taken from `getState()`, `s`, `st`, `state` (issue 570). A nested destructuring (`{ a: { b }, <name> }`) is not seen.
const SLICE = /createSlice\(\s*\{\s*name:\s*"(\d+)"/g;
const STATE = String.raw`(?:(?<![\w$.])(?:s|st|state|was)|\bgetState\(\s*\))`;
const READ = new RegExp(`${STATE}\\s*\\.\\s*([\\w$]+)`, 'g');
const INDEX = new RegExp(`${STATE}\\s*\\[\\s*"(\\d+)"\\s*\\]`, 'g');
const TAKEN = /useAppSelector\(\s*\(\s*\{([^{}]*)\}|\{([^{}]*)\}\s*:\s*RootState\b|\{([^{}]*)\}\s*=\s*(?:(?:[\w$]+\.)?getState\(\s*\)|(?:s|st|state)\b)/g;
// the slice names an access reads, from the masked code and its strings
function reads(code: string, strings: string[]): string[] {
  const out = [...code.matchAll(READ)].map((m) => m[1]!);
  for (const m of code.matchAll(INDEX)) out.push(strings[Number(m[1])]!);
  for (const m of code.matchAll(TAKEN)) for (const k of (m[1] ?? m[2] ?? m[3]!).split(',')) out.push(k.split(':')[0]!.trim());
  return out;
}

// The violations in `root` (a repository checkout), as sorted "<file> -> <what>" entries.
function scan(root: string): string[] {
  const src = path.join(root, WEB);
  const out = new Set<string>();
  const owner = new Map<string, string>();
  for (const abs of files(src, /\.tsx?$/)) {
    const rel = path.relative(src, abs).split(path.sep).join('/');
    if (/\.test\.tsx?$/.test(rel) || role(rel).role !== 'plugin') continue;
    const { code, strings } = mask(fs.readFileSync(abs, 'utf8'));
    for (const m of code.matchAll(SLICE)) owner.set(strings[Number(m[1])], role(rel).folder);
  }
  for (const abs of files(src, /\.tsx?$/)) {
    const rel = path.relative(src, abs).split(path.sep).join('/');
    const me = role(rel);
    const test = /\.test\.tsx?$/.test(rel) || TEST_HELPERS.includes(rel) || me.role === 'harness';
    const { code, strings } = mask(fs.readFileSync(abs, 'utf8'));
    const add = (what: string) => out.add(`${WEB}/${rel} -> ${what}`);
    for (const m of code.matchAll(IMPORTS)) {
      const target = resolve(abs, strings[Number(m.slice(1).find((g) => g !== undefined))], src);
      if (!target || target.startsWith('..')) continue;
      const it = role(target);
      if (it.role === 'harness') {
        if (!test) add(`${WEB}/${target}`);
      } else if (!test && (it.role !== me.role || it.folder !== me.folder)) {
        const bad = (me.role === 'plugin' && !SDK.includes(target)) || (me.role === 'core' && it.role === 'plugin');
        if (bad) add(`${WEB}/${target}`);
      }
    }
    if (test) continue;
    const sdk = me.role === 'core' && me.folder === 'sdk';
    if (/\blocalStorage\b/.test(code) && !sdk && rel !== 'core/net/auth.ts') add('localStorage');
    if (GATE.test(code)) add('protocol gate');
    if (/\buseSyncExternalStore\b/.test(code) && !sdk) add('useSyncExternalStore');
    if (singleton(code) && !sdk && !SINGLETONS[rel]) add('module singleton');
    // the page's visibility pauses polls in the SDK's repository and is read nowhere else (pageVisible)
    if (/\bvisibilityState\b/.test(code) && !sdk) add('visibilityState');
    for (const name of reads(code, strings)) {
      const of = owner.get(name);
      if (of && (me.role !== 'plugin' || of !== me.folder)) add(`slice ${name}`);
    }
  }
  const phone = path.join(root, PHONE);
  for (const abs of files(phone, /\.dart$/)) {
    if (GATE.test(mask(fs.readFileSync(abs, 'utf8')).code)) out.add(`${PHONE}/${path.relative(phone, abs).split(path.sep).join('/')} -> protocol gate`);
  }
  return [...out].sort();
}

// The rule an entry breaks, named in a failure.
function classify(entry: string): string {
  const [from, to] = entry.split(' -> ');
  if (to.startsWith('slice ')) return 'foreign slice';
  if (!to.startsWith(`${WEB}/`)) return to;
  const a = role(from.slice(WEB.length + 1)), b = role(to.slice(WEB.length + 1));
  if (b.role === 'harness') return 'testing outside tests';
  if (a.role === 'core') return 'core→plugin';
  return b.role === 'plugin' ? 'plugin→plugin' : 'plugin→core';
}

// --- the real tree

it('the tree breaks no rule', () => {
  expect(scan(REPO).map((e) => `${classify(e)}: ${e}`)).toEqual([]);
  // the allowlist names only singletons that are still there
  const gone = Object.keys(SINGLETONS).filter((f) => !singleton(mask(fs.readFileSync(path.join(REPO, WEB, f), { encoding: 'utf8', flag: 'r' })).code));
  expect(gone, 'allowlisted singletons that are gone').toEqual([]);
});

// The plugin modules the SDK barrels load, through the core modules they load (type-only imports aside): a plugin
// module evaluated inside the SDK's own evaluation sees `@/sdk` half-built, a load-order (TDZ) hazard. Issue 511 cut
// the keymap's edges (step 9c), the store's chat and comment helpers and the media controller (step 10b), refs' file
// helpers and the page frame's rects (step 10c, which moved both into the core): none is left.
function sdkReach(root: string): string[] {
  const src = path.join(root, WEB);
  const out = new Set<string>(), seen = new Set<string>(SDK), queue = [...SDK];
  for (let rel = queue.shift(); rel; rel = queue.shift()) {
    const abs = path.join(src, rel);
    const { code, strings } = mask(fs.readFileSync(abs, 'utf8'));
    for (const m of code.matchAll(IMPORTS)) {
      if (/^(?:import|export)\s+type\b/.test(m[0])) continue;
      const target = resolve(abs, strings[Number(m.slice(1).find((g) => g !== undefined))], src);
      if (!target || target.startsWith('..') || !/\.tsx?$/.test(target)) continue;
      if (role(target).role === 'plugin') out.add(`${rel} -> ${target}`);
      else if (!seen.has(target)) (seen.add(target), queue.push(target));
    }
  }
  return [...out].sort();
}

it('the SDK barrels load no plugin module', () => {
  expect(sdkReach(REPO)).toEqual([]);
});

// --- the scanner on a fixture tree

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-bounds-'));
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  }
  return root;
}

const W = 'web/src';
const base = {
  [`${W}/core/sdk/index.ts`]: '',
  [`${W}/core/sdk/ui.ts`]: '',
  [`${W}/core/sdk/connections.ts`]: '',
  [`${W}/plugins/media/x.ts`]: '',
  [`${W}/plugins/media/y.ts`]: '',
  [`${W}/plugins/media/side.ts`]: '',
  [`${W}/plugins/media/lazy.ts`]: '',
  [`${W}/plugins/media/types.ts`]: '',
  [`${W}/plugins/feed/own.ts`]: '',
  [`${W}/core/lib/util.ts`]: '',
  [`${W}/core/testing/index.tsx`]: '',
};

it('finds every import form, across lines, and resolves `@/` and relative specifiers', () => {
  const root = tree({
    ...base,
    [`${W}/plugins/feed/Feed.tsx`]: [
      "import {\n  a,\n  b,\n} from '@/plugins/media/x.ts';",
      "import type { T } from '../media/types.ts';",
      "export { c } from '@/plugins/media/y.ts';",
      "export * from \"../../core/lib/util.ts\";",
      "import '@/plugins/media/side.ts';",
      "const lazy = () => import('@/plugins/media/lazy.ts');",
    ].join('\n'),
  });
  expect(scan(root)).toEqual([
    `${W}/plugins/feed/Feed.tsx -> ${W}/core/lib/util.ts`,
    `${W}/plugins/feed/Feed.tsx -> ${W}/plugins/media/lazy.ts`,
    `${W}/plugins/feed/Feed.tsx -> ${W}/plugins/media/side.ts`,
    `${W}/plugins/feed/Feed.tsx -> ${W}/plugins/media/types.ts`,
    `${W}/plugins/feed/Feed.tsx -> ${W}/plugins/media/x.ts`,
    `${W}/plugins/feed/Feed.tsx -> ${W}/plugins/media/y.ts`,
  ]);
});

it('ignores a specifier inside a string, a template or a comment', () => {
  const root = tree({
    ...base,
    [`${W}/plugins/feed/Feed.tsx`]: [
      "const s = \"import a from '@/plugins/media/x.ts'\";",
      "const t = `export * from '@/plugins/media/y.ts'`;",
      "// import b from '@/plugins/media/side.ts';",
      "/* import('@/plugins/media/lazy.ts');\n import '@/plugins/media/types.ts'; */",
      "const u = 'http://example.test'; import { ok } from '@/core/lib/util.ts';",
    ].join('\n'),
  });
  expect(scan(root)).toEqual([`${W}/plugins/feed/Feed.tsx -> ${W}/core/lib/util.ts`]);
});

it('allows the SDK entries, the own folder, shared and packages to a plugin', () => {
  const root = tree({
    ...base,
    [`${W}/plugins/feed/Feed.tsx`]: [
      "import { a } from '@/sdk';",
      "import { b } from '@/sdk/ui.ts';",
      "import { c } from './own.ts';",
      "import { d } from '@nota-bene/shared';",
      "import { e } from '@nota-bene/shared/protocol';",
      "import { useState } from 'react';",
      "import url from './own.ts?url';",
    ].join('\n'),
  });
  expect(scan(root)).toEqual([]);
});

it('names each rule: plugin→core past the SDK, core→plugin, @/testing outside tests', () => {
  const root = tree({
    ...base,
    [`${W}/plugins/feed/Feed.tsx`]: "import { c } from '@/sdk/connections.ts';\nimport { u } from '@/core/lib/util.ts';",
    [`${W}/core/shell/Header.tsx`]: "import { x } from '@/plugins/media/x.ts';\nimport { u } from '@/core/lib/util.ts';",
    [`${W}/core/lib/h.ts`]: "import { t } from '@/core/testing';",
    [`${W}/App.tsx`]: "import { x } from '@/plugins/media/x.ts';",
  });
  const found = scan(root);
  expect(found).toEqual([
    `${W}/core/lib/h.ts -> ${W}/core/testing/index.tsx`,
    `${W}/core/shell/Header.tsx -> ${W}/plugins/media/x.ts`,
    `${W}/plugins/feed/Feed.tsx -> ${W}/core/lib/util.ts`,
    `${W}/plugins/feed/Feed.tsx -> ${W}/core/sdk/connections.ts`,
  ]);
  expect(found.map(classify)).toEqual(['testing outside tests', 'core→plugin', 'plugin→core', 'plugin→core']);
  expect(classify(`${W}/plugins/feed/a.ts -> ${W}/plugins/media/x.ts`)).toBe('plugin→plugin');
});

it('exempts test files, the listed test helpers and the harness from the folder rules', () => {
  const root = tree({
    ...base,
    [`${W}/plugins/feed/Feed.test.tsx`]: "import { x } from '@/plugins/media/x.ts';\nimport { t } from '@/core/testing';",
    [`${W}/core/shell/Header.test.ts`]: "import { x } from '@/plugins/media/x.ts';\nlocalStorage.clear();",
    [`${W}/core/testing/fake.ts`]: "import { x } from '@/plugins/media/x.ts';",
    [`${W}/plugins/cut/testCut.tsx`]: "import { u } from '@/core/lib/util.ts';\nimport { t } from '@/core/testing';",
  });
  expect(scan(root)).toEqual([]);
  // any other file named like a helper is product code
  expect(scan(tree({ ...base, [`${W}/plugins/feed/testMode.ts`]: "import { t } from '@/core/testing';\nlocalStorage.clear();" }))).toEqual([
    `${W}/plugins/feed/testMode.ts -> localStorage`,
    `${W}/plugins/feed/testMode.ts -> ${W}/core/testing/index.tsx`,
  ]);
});

it('counts the text rules: localStorage, protocol gates, useSyncExternalStore, visibilityState', () => {
  const root = tree({
    ...base,
    [`${W}/plugins/feed/Feed.tsx`]: [
      "const v = localStorage.getItem('k'); // localStorage",
      "const on = useAppSelector((s) => s.controls.protocol >= 14);",
      "const n = useSyncExternalStore(sub, get);",
      "const best = (stamps.get(a) ?? 0) >= (stamps.get(b) ?? 0);",
      "if (document.visibilityState === 'hidden') return;",
    ].join('\n'),
    [`${W}/plugins/comments/named.ts`]: "s.ops = ev.protocol >= OPS_PROTOCOL;",
    [`${W}/plugins/comments/below.ts`]: "if (st.controls.protocol < 16) return;",
    [`${W}/plugins/comments/table.ts`]: "const labelsFor = (protocol: number) => ALL.filter((l) => protocol >= (SINCE[l.id] ?? 0));",
    [`${W}/plugins/comments/notGates.ts`]: [
      "const https = loc.protocol === 'https:';",
      "s.protocol = 0;",
      "const f = (protocol: number) => protocol;",
      "if (tab.detectProtocolOk) go();",
      "const OPS_PROTOCOL = 7;",
    ].join('\n'),
    [`${W}/core/lib/quiet.ts`]: "// localStorage, useSyncExternalStore and protocol >= 4 in a comment\nconst k = 'localStorage';",
    [`${W}/core/sdk/storage.ts`]: "localStorage.setItem('k', 'v'); useSyncExternalStore(a, b); document.visibilityState;",
    [`${W}/core/net/auth.ts`]: "localStorage.getItem('t');",
    ['mobile/app/lib/chat/window_tab.dart']: "bool get v => (protocol ?? 0) >= 14;\nbool get o => (tab.protocol ?? 0) >= opsProtocol;",
    ['mobile/app/lib/chat/quiet.dart']: "/// (protocol ?? 0) >= 14 is how it used to read\nconst p = 3;",
  });
  expect(scan(root)).toEqual([
    'mobile/app/lib/chat/window_tab.dart -> protocol gate',
    `${W}/plugins/comments/below.ts -> protocol gate`,
    `${W}/plugins/comments/named.ts -> protocol gate`,
    `${W}/plugins/comments/table.ts -> protocol gate`,
    `${W}/plugins/feed/Feed.tsx -> localStorage`,
    `${W}/plugins/feed/Feed.tsx -> protocol gate`,
    `${W}/plugins/feed/Feed.tsx -> useSyncExternalStore`,
    `${W}/plugins/feed/Feed.tsx -> visibilityState`,
  ]);
  expect(classify('mobile/app/lib/chat/window_tab.dart -> protocol gate')).toBe('protocol gate');
});

it('counts a module singleton outside the SDK that the allowlist does not name', () => {
  const root = tree({
    ...base,
    // a hand-rolled value: a listener set at module level, read through useStored
    [`${W}/plugins/feed/flag.ts`]: "let on = false;\nconst subs = new Set<() => void>();\nexport const useOn = () => useStored({ subscribe: (f) => (subs.add(f), () => subs.delete(f)), get: () => on });",
    // an object-literal read alone counts too
    [`${W}/plugins/media/y.ts`]: "export const usePlaying = (p) => useStored({ subscribe: p.subscribe, get: p.state });",
    // the allowlist's own, a stored item, a set inside a function, the SDK's
    [`${W}/plugins/feed/MsgTime.tsx`]: "const useDay = () => useStored({ subscribe: subscribeDay, get: currentDay });",
    [`${W}/plugins/feed/own.ts`]: "const v = useStored(savedSplit);\nfunction f() {\n  const subs = new Set<() => void>();\n}",
    [`${W}/core/sdk/storage.ts`]: "const subs = new Set<() => void>();\nuseStored({ subscribe, get });",
  });
  expect(scan(root)).toEqual([`${W}/plugins/feed/flag.ts -> module singleton`, `${W}/plugins/media/y.ts -> module singleton`]);
  expect(classify(`${W}/plugins/feed/flag.ts -> module singleton`)).toBe('module singleton');
});

it("counts a read of another plugin's slice, wherever it is read from", () => {
  const root = tree({
    ...base,
    [`${W}/plugins/comments/slice.ts`]: "export const commentsSlice = createSlice({ name: 'comments', initialState, reducers: {} });\nconst own = (s: RootState) => s.comments.items;",
    [`${W}/plugins/files/treeSlice.ts`]: "export const treeSlice = createSlice({\n  name: 'tree',\n  initialState,\n  reducers: {},\n});",
    [`${W}/plugins/feed/uiSlice.ts`]: [
      "const n = createSelector([(s: RootState) => s.comments.items], f);",
      "const core = (s: RootState) => s.feed.items.length + s.controls.protocol;",
      "const other = (x: Box) => x.comments + this.s.tree;",
      "const text = 's.comments'; // st.tree.open",
    ].join('\n'),
    [`${W}/plugins/vcs/store.ts`]: "start({ predicate: (_a, st, was) => st.tree.open && !was.tree.open, effect: (_a, api) => api.getState().tree });",
    [`${W}/core/shell/Header.tsx`]: "const open = useAppSelector((state) => state.tree.open);",
    // issue 570: a bracket read and a destructured state
    [`${W}/plugins/cut/a.ts`]: "const n = (s: RootState) => s['comments'].items;\nconst t = useAppSelector(({ tree, tabs }) => tree.open);",
    [`${W}/plugins/media/b.ts`]: "const f = ({ files }: RootState) => files.load;\nconst { tree: t } = getState();\nconst { feed } = api.getState();",
    [`${W}/plugins/page/props.tsx`]: "const View = ({ files, tree }: { files: string[]; tree: Node }) => files.length;\nconst { comments } = props;",
    [`${W}/plugins/comments/Feed.test.tsx`]: "expect(store.getState().tree.open).toBe(true);",
  });
  expect(scan(root)).toEqual([
    `${W}/core/shell/Header.tsx -> slice tree`,
    `${W}/plugins/cut/a.ts -> slice comments`,
    `${W}/plugins/cut/a.ts -> slice tree`,
    `${W}/plugins/feed/uiSlice.ts -> slice comments`,
    `${W}/plugins/media/b.ts -> slice tree`,
    `${W}/plugins/vcs/store.ts -> slice tree`,
  ]);
  expect(classify(`${W}/plugins/vcs/store.ts -> slice tree`)).toBe('foreign slice');
});

it('refuses a web/src folder the rule does not know', () => {
  const root = tree({ ...base, [`${W}/newthing/a.ts`]: '' });
  expect(() => scan(root)).toThrow(/newthing/);
});
