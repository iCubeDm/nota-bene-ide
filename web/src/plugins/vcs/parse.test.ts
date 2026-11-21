import { expect, it } from 'vitest';
import { parsePatch } from './parse.ts';

it('numbers both sides and counts changes', () => {
  const p = parsePatch('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -2,2 +2,2 @@ fn\n same\n-old\n+new\n');
  expect(p).toMatchObject({ add: 1, del: 1, binary: false });
  expect(p.hunks[0]!.rows).toEqual([
    { t: ' ', o: 2, n: 2, s: 'same' },
    { t: '-', o: 3, s: 'old' },
    { t: '+', n: 3, s: 'new' },
  ]);
});

it('a line that only looks like a header stays content', () => {
  const p = parsePatch('@@ -1 +1 @@\n--- not a header\n+++ nor this\n+@@ -9 +9 @@\n');
  expect(p.hunks).toHaveLength(1);
  expect(p.hunks[0]!.rows.map((r) => r.s)).toEqual(['-- not a header', '++ nor this', '@@ -9 +9 @@']);
});

it('the missing-newline note is no row; a binary file has no hunks; an empty patch is empty', () => {
  expect(parsePatch('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n').hunks[0]!.rows).toHaveLength(2);
  expect(parsePatch('diff --git a/x b/x\nBinary files a/x and b/x differ\n')).toMatchObject({ binary: true, hunks: [] });
  expect(parsePatch('')).toEqual({ add: 0, del: 0, binary: false, hunks: [] });
});
