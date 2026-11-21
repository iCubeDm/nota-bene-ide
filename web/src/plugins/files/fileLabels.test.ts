import { expect, it } from 'vitest';
import { fileLabels } from './fileLabels.ts';

const labels = (paths: string[]) => Object.fromEntries(fileLabels(paths));

it('a file name alone while no other open file shares it', () => {
  expect(labels(['src/app.ts', 'README.md', 'docs/guide.md'])).toEqual({ 'src/app.ts': 'app.ts', 'README.md': 'README.md', 'docs/guide.md': 'guide.md' });
});

it('files that share a name take as many parent folders as tell them apart', () => {
  expect(labels(['src/app.ts', 'lib/app.ts', 'notes.md'])).toEqual({ 'src/app.ts': 'src/app.ts', 'lib/app.ts': 'lib/app.ts', 'notes.md': 'notes.md' });
  expect(labels(['a/src/app.ts', 'b/src/app.ts', 'lib/app.ts'])).toEqual({ 'a/src/app.ts': 'a/src/app.ts', 'b/src/app.ts': 'b/src/app.ts', 'lib/app.ts': 'lib/app.ts' });
});

it('a file at the root against one in a folder: the root one keeps its name', () => {
  expect(labels(['app.ts', 'src/app.ts'])).toEqual({ 'app.ts': 'app.ts', 'src/app.ts': 'src/app.ts' });
});

it('the same path open twice (another branch) keeps the one label', () => {
  expect(labels(['src/app.ts', 'src/app.ts'])).toEqual({ 'src/app.ts': 'app.ts' });
});
