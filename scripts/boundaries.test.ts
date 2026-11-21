// The import rule of issue 511 (docs/superpowers/specs/2026-11-20-core-plugins-design.md, "The import rule"):
// plugins import only the SDK, core imports no plugin, `@/testing` is test-only, plus three text rules. Violations
// that exist today live in boundaries.baseline.json, which may only shrink: a new violation fails, and so does a
// baseline entry that is gone. UPDATE_BOUNDARIES=1 rewrites the baseline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

const REPO = path.resolve(import.meta.dirname, '..');
const BASELINE = path.join(REPO, 'scripts/boundaries.baseline.json');

// Every web/src folder by role (the spec's folder table). A folder not listed fails the scan until it is classified.
const CORE = ['anchors', 'components', 'i18n', 'lib', 'net', 'refs', 'sdk', 'shell', 'store', 'tabs', 'theme'];
const PLUGINS = ['attachments', 'comments', 'composer', 'controls', 'cut', 'diagram', 'feed', 'files', 'media', 'page',
  'projects', 'remote', 'settings', 'stats', 'subagent', 'tasks', 'update', 'usage', 'vcs', 'voice'];
const HARNESS = 'testing'; // test-only code, importable from tests only
const SDK = ['sdk/index.ts', 'sdk/ui.ts'];
// shared test setups outside the harness, held to the test files' rules
const TEST_HELPERS = ['cut/testCut.tsx'];
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

function files(dir: string, ext: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => ext.test(f)).map((f) => path.join(dir, f));
}

// `@/x` and `./x` to a web/src-relative file; a package or an unresolvable path returns undefined.
function resolve(from: string, spec: string, src: string): string | undefined {
  spec = spec.replace(/\?.*$/, '');
  const abs = spec.startsWith('@/') ? path.join(src, spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : undefined;
  if (!abs) return undefined;
  const hit = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map((e) => abs + e).find((p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile());
  return path.relative(src, hit ?? abs).split(path.sep).join('/');
}

type Role = 'core' | 'plugin' | 'root' | 'harness';
function role(rel: string): { role: Role; folder: string } {
  const folder = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '';
  if (!folder) return { role: 'root', folder };
  if (folder === HARNESS) return { role: 'harness', folder };
  if (CORE.includes(folder)) return { role: 'core', folder };
  if (PLUGINS.includes(folder)) return { role: 'plugin', folder };
  throw new Error(`boundaries: web/src/${folder}/ is neither core nor a plugin; classify it in scripts/boundaries.test.ts`);
}

// The violations in `root` (a repository checkout), as sorted "<file> -> <what>" entries.
function scan(root: string): string[] {
  const src = path.join(root, WEB);
  const out = new Set<string>();
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
      } else if (!test && it.folder !== me.folder) {
        const bad = (me.role === 'plugin' && !SDK.includes(target)) || (me.role === 'core' && it.role === 'plugin');
        if (bad) add(`${WEB}/${target}`);
      }
    }
    if (test) continue;
    if (/\blocalStorage\b/.test(code) && me.folder !== 'sdk' && rel !== 'net/auth.ts') add('localStorage');
    if (GATE.test(code)) add('protocol gate');
    if (/\buseSyncExternalStore\b/.test(code) && me.folder !== 'sdk') add('useSyncExternalStore');
    // the page's visibility pauses polls in the SDK's repository and is read nowhere else (pageVisible)
    if (/\bvisibilityState\b/.test(code) && me.folder !== 'sdk') add('visibilityState');
  }
  const phone = path.join(root, PHONE);
  for (const abs of files(phone, /\.dart$/)) {
    if (GATE.test(mask(fs.readFileSync(abs, 'utf8')).code)) out.add(`${PHONE}/${path.relative(phone, abs).split(path.sep).join('/')} -> protocol gate`);
  }
  return [...out].sort();
}

// The rule an entry breaks, for the printed counts.
function classify(entry: string): string {
  const [from, to] = entry.split(' -> ');
  if (!to.startsWith(`${WEB}/`)) return to;
  const a = role(from.slice(WEB.length + 1)), b = role(to.slice(WEB.length + 1));
  if (b.role === 'harness') return 'testing outside tests';
  if (a.role === 'core') return 'core→plugin';
  return b.role === 'plugin' ? 'plugin→plugin' : 'plugin→core';
}

function compare(now: string[], base: string[]): { added: string[]; stale: string[] } {
  const has = new Set(now), had = new Set(base);
  return { added: now.filter((e) => !had.has(e)), stale: base.filter((e) => !has.has(e)) };
}

// --- the real tree

it('the tree keeps to the baseline', () => {
  const now = scan(REPO);
  let base: string[] = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const count = (list: string[]) => list.reduce<Record<string, number>>((n, e) => ((n[classify(e)] = (n[classify(e)] ?? 0) + 1), n), {});
  const before = count(base), after = count(now);
  const rules = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  console.log(`boundaries:\n${rules.map((r) => `  ${r}: ${before[r] ?? 0} -> ${after[r] ?? 0}`).join('\n')}`);
  if (process.env.UPDATE_BOUNDARIES) fs.writeFileSync(BASELINE, JSON.stringify((base = now), null, 2) + '\n');
  const { added, stale } = compare(now, base);
  expect(added, 'new violations').toEqual([]);
  expect(stale, 'stale baseline entries: commit the shrink with UPDATE_BOUNDARIES=1').toEqual([]);
});

// The plugin modules the SDK barrels load, through the core modules they load (type-only imports aside): a plugin
// module evaluated inside the SDK's own evaluation sees `@/sdk` half-built, a load-order (TDZ) hazard. Issue 511 cut
// the keymap's edges (step 9c); these are left and may only go: the store's chat and comment helpers and the media
// controller (steps 10a/10b), refs' file helpers and the page frame's rects (10c).
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

it('the SDK barrels load no plugin module but the listed ones', () => {
  expect(sdkReach(REPO)).toEqual([
    'anchors/scroll.ts -> page/frame.ts',
    'refs/refs.ts -> files/kinds.ts',
    'refs/refs.ts -> files/sources.ts',
    'refs/refs.ts -> files/tmpImages.ts',
    'store/store.ts -> feed/uiSlice.ts',
    'store/store.ts -> media/mediaController.ts',
    'store/store.ts -> subagent/slice.ts',
    'store/store.ts -> voice/lang.ts',
  ]);
});

it('fails a new violation and a stale baseline entry', () => {
  expect(compare(['a', 'b'], ['a', 'b'])).toEqual({ added: [], stale: [] });
  expect(compare(['a', 'b', 'c'], ['a', 'b'])).toEqual({ added: ['c'], stale: [] });
  expect(compare(['a'], ['a', 'b'])).toEqual({ added: [], stale: ['b'] });
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
  [`${W}/sdk/index.ts`]: '',
  [`${W}/sdk/ui.ts`]: '',
  [`${W}/sdk/connections.ts`]: '',
  [`${W}/media/x.ts`]: '',
  [`${W}/media/y.ts`]: '',
  [`${W}/media/side.ts`]: '',
  [`${W}/media/lazy.ts`]: '',
  [`${W}/media/types.ts`]: '',
  [`${W}/feed/own.ts`]: '',
  [`${W}/lib/util.ts`]: '',
  [`${W}/testing/index.tsx`]: '',
};

it('finds every import form, across lines, and resolves `@/` and relative specifiers', () => {
  const root = tree({
    ...base,
    [`${W}/feed/Feed.tsx`]: [
      "import {\n  a,\n  b,\n} from '@/media/x.ts';",
      "import type { T } from '../media/types.ts';",
      "export { c } from '@/media/y.ts';",
      "export * from \"../lib/util.ts\";",
      "import '@/media/side.ts';",
      "const lazy = () => import('@/media/lazy.ts');",
    ].join('\n'),
  });
  expect(scan(root)).toEqual([
    `${W}/feed/Feed.tsx -> ${W}/lib/util.ts`,
    `${W}/feed/Feed.tsx -> ${W}/media/lazy.ts`,
    `${W}/feed/Feed.tsx -> ${W}/media/side.ts`,
    `${W}/feed/Feed.tsx -> ${W}/media/types.ts`,
    `${W}/feed/Feed.tsx -> ${W}/media/x.ts`,
    `${W}/feed/Feed.tsx -> ${W}/media/y.ts`,
  ]);
});

it('ignores a specifier inside a string, a template or a comment', () => {
  const root = tree({
    ...base,
    [`${W}/feed/Feed.tsx`]: [
      "const s = \"import a from '@/media/x.ts'\";",
      "const t = `export * from '@/media/y.ts'`;",
      "// import b from '@/media/side.ts';",
      "/* import('@/media/lazy.ts');\n import '@/media/types.ts'; */",
      "const u = 'http://example.test'; import { ok } from '@/lib/util.ts';",
    ].join('\n'),
  });
  expect(scan(root)).toEqual([`${W}/feed/Feed.tsx -> ${W}/lib/util.ts`]);
});

it('allows the SDK entries, the own folder, shared and packages to a plugin', () => {
  const root = tree({
    ...base,
    [`${W}/feed/Feed.tsx`]: [
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
    [`${W}/feed/Feed.tsx`]: "import { c } from '@/sdk/connections.ts';\nimport { u } from '@/lib/util.ts';",
    [`${W}/shell/Header.tsx`]: "import { x } from '@/media/x.ts';\nimport { u } from '@/lib/util.ts';",
    [`${W}/lib/h.ts`]: "import { t } from '@/testing';",
    [`${W}/App.tsx`]: "import { x } from '@/media/x.ts';",
  });
  const found = scan(root);
  expect(found).toEqual([
    `${W}/feed/Feed.tsx -> ${W}/lib/util.ts`,
    `${W}/feed/Feed.tsx -> ${W}/sdk/connections.ts`,
    `${W}/lib/h.ts -> ${W}/testing/index.tsx`,
    `${W}/shell/Header.tsx -> ${W}/media/x.ts`,
  ]);
  expect(found.map(classify)).toEqual(['plugin→core', 'plugin→core', 'testing outside tests', 'core→plugin']);
  expect(classify(`${W}/feed/a.ts -> ${W}/media/x.ts`)).toBe('plugin→plugin');
});

it('exempts test files, the listed test helpers and the harness from the folder rules', () => {
  const root = tree({
    ...base,
    [`${W}/feed/Feed.test.tsx`]: "import { x } from '@/media/x.ts';\nimport { t } from '@/testing';",
    [`${W}/shell/Header.test.ts`]: "import { x } from '@/media/x.ts';\nlocalStorage.clear();",
    [`${W}/testing/fake.ts`]: "import { x } from '@/media/x.ts';",
    [`${W}/cut/testCut.tsx`]: "import { u } from '@/lib/util.ts';\nimport { t } from '@/testing';",
  });
  expect(scan(root)).toEqual([]);
  // any other file named like a helper is product code
  expect(scan(tree({ ...base, [`${W}/feed/testMode.ts`]: "import { t } from '@/testing';\nlocalStorage.clear();" }))).toEqual([
    `${W}/feed/testMode.ts -> localStorage`,
    `${W}/feed/testMode.ts -> ${W}/testing/index.tsx`,
  ]);
});

it('counts the text rules: localStorage, protocol gates, useSyncExternalStore, visibilityState', () => {
  const root = tree({
    ...base,
    [`${W}/feed/Feed.tsx`]: [
      "const v = localStorage.getItem('k'); // localStorage",
      "const on = useAppSelector((s) => s.controls.protocol >= 14);",
      "const n = useSyncExternalStore(sub, get);",
      "const best = (stamps.get(a) ?? 0) >= (stamps.get(b) ?? 0);",
      "if (document.visibilityState === 'hidden') return;",
    ].join('\n'),
    [`${W}/comments/named.ts`]: "s.ops = ev.protocol >= OPS_PROTOCOL;",
    [`${W}/comments/below.ts`]: "if (st.controls.protocol < 16) return;",
    [`${W}/comments/table.ts`]: "const labelsFor = (protocol: number) => ALL.filter((l) => protocol >= (SINCE[l.id] ?? 0));",
    [`${W}/comments/notGates.ts`]: [
      "const https = loc.protocol === 'https:';",
      "s.protocol = 0;",
      "const f = (protocol: number) => protocol;",
      "if (tab.detectProtocolOk) go();",
      "const OPS_PROTOCOL = 7;",
    ].join('\n'),
    [`${W}/lib/quiet.ts`]: "// localStorage, useSyncExternalStore and protocol >= 4 in a comment\nconst k = 'localStorage';",
    [`${W}/sdk/storage.ts`]: "localStorage.setItem('k', 'v'); useSyncExternalStore(a, b); document.visibilityState;",
    [`${W}/net/auth.ts`]: "localStorage.getItem('t');",
    ['mobile/app/lib/chat/window_tab.dart']: "bool get v => (protocol ?? 0) >= 14;\nbool get o => (tab.protocol ?? 0) >= opsProtocol;",
    ['mobile/app/lib/chat/quiet.dart']: "/// (protocol ?? 0) >= 14 is how it used to read\nconst p = 3;",
  });
  expect(scan(root)).toEqual([
    'mobile/app/lib/chat/window_tab.dart -> protocol gate',
    `${W}/comments/below.ts -> protocol gate`,
    `${W}/comments/named.ts -> protocol gate`,
    `${W}/comments/table.ts -> protocol gate`,
    `${W}/feed/Feed.tsx -> localStorage`,
    `${W}/feed/Feed.tsx -> protocol gate`,
    `${W}/feed/Feed.tsx -> useSyncExternalStore`,
    `${W}/feed/Feed.tsx -> visibilityState`,
  ]);
  expect(classify('mobile/app/lib/chat/window_tab.dart -> protocol gate')).toBe('protocol gate');
});

it('refuses a web/src folder the rule does not know', () => {
  const root = tree({ ...base, [`${W}/newthing/a.ts`]: '' });
  expect(() => scan(root)).toThrow(/newthing/);
});
