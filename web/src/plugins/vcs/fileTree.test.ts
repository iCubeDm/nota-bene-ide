import { expect, it } from 'vitest';
import { fileTree, type TreeDir } from './fileTree.ts';

const show = (d: TreeDir<{ path: string }>, pad = ''): string[] => [
  ...d.dirs.flatMap((s) => [`${pad}${s.name}/`, ...show(s, `${pad}  `)]),
  ...d.files.map((f) => `${pad}${f.path.slice(f.path.lastIndexOf('/') + 1)}`),
];

it('folders first, then files, each by name; a chain of single folders is one row', () => {
  const t = fileTree(['README.md', 'server/src/agent/codex/map.ts', 'server/src/agent/codex/controls.ts', 'server/src/main.ts', 'web/src/i18n/ru.ts', 'AGENTS.md'].map((path) => ({ path })));
  expect(show(t)).toEqual([
    'server/src/',
    '  agent/codex/',
    '    controls.ts',
    '    map.ts',
    '  main.ts',
    'web/src/i18n/',
    '  ru.ts',
    'AGENTS.md',
    'README.md',
  ]);
  expect(t.dirs[0]!.dirs[0]!.path).toBe('server/src/agent/codex'); // the folded row's path is its deepest folder
});

it('no files, no folders', () => {
  expect(fileTree([])).toEqual({ kind: 'dir', path: '', name: '', dirs: [], files: [] });
});
