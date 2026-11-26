import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import hljs from 'highlight.js';
import { expect, it, vi } from 'vitest';
import { previewRanges } from './livePreview.ts';

const at = (doc: string, caret = doc.length) => {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(caret), extensions: [markdown({ base: markdownLanguage })] });
  return previewRanges(state, [{ from: 0, to: doc.length }]);
};
const cls = (r: ReturnType<typeof at>) => r.marks.map((m) => m.cls);

it('hides the marks of a span the caret is not in', () => {
  const r = at('**a** b');
  expect(r.hide).toEqual([[0, 2], [3, 5]]);
  expect(r.marks).toContainEqual({ from: 2, to: 3, cls: 'nb-md-strong' });
});

it('shows the marks while the caret is inside the span', () => {
  expect(at('**a** b', 3).hide).toEqual([]);
});

it('hides code, emphasis and strikethrough marks', () => {
  const r = at('`x` and _y_ and ~~z~~ ');
  expect(r.hide).toEqual([[0, 1], [2, 3], [8, 9], [10, 11], [16, 18], [19, 21]]);
  expect(cls(r)).toEqual(expect.arrayContaining(['nb-md-code', 'nb-md-em', 'nb-md-strike']));
});

it('a link shows its text only', () => {
  const doc = '[site](https://example.com) ';
  const r = at(doc);
  expect(r.hide).toEqual([[0, 1], [5, 27]]);
  expect(r.marks).toContainEqual({ from: 1, to: 5, cls: 'nb-md-link' });
});

it('a fenced block: its lines are a block, its fences hide while the caret is off them', () => {
  const doc = '```ts\nlet a\n```';
  const off = at(doc + '\n', doc.length + 1);
  expect(off.hide).toEqual([[0, 5], [12, 15]]);
  expect(off.lines.filter((l) => l.cls === 'nb-md-block').map((l) => l.at)).toEqual([0, 6, 12]);
  expect(at(doc, 2).hide).toEqual([[12, 15]]);
});

it('a bullet and a quote mark are drawn, not hidden as text', () => {
  const r = at('- one\n> two');
  expect(r.bullets).toEqual([[0, 2]]);
  expect(r.hide).toEqual([[6, 8]]);
  expect(r.lines).toContainEqual({ at: 6, cls: 'nb-md-quote' });
});

it('an unclosed fence is a block to the end; once closed, the marks after it hide again', () => {
  expect(at('```\nopen').lines.filter((l) => l.cls === 'nb-md-block').map((l) => l.at)).toEqual([0, 4]);
  expect(at('```\nopen\n```\n**b**', 0).hide).toContainEqual([13, 15]);
});

it('code with a known language is highlighted', () => {
  const r = at('```js\nlet a\n```\n');
  expect(r.marks.find((m) => m.from === 6 && m.to === 9)?.cls).toMatch(/hljs-keyword/);
});

it('only the visible ranges are decorated', () => {
  const doc = Array.from({ length: 2000 }, (_, i) => `**${i}**`).join('\n');
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  const r = previewRanges(state, [{ from: 0, to: 100 }]);
  expect(r.hide.length).toBeGreaterThan(0);
  expect(r.hide.every(([from]) => from <= 100)).toBe(true);
});

it('list items line up: each a hanging item at its level, its number muted, a nested item\'s spaces hidden', () => {
  const r = at('1. a\n   2. b\n- c\n  - d', 0);
  expect(r.lines.filter((l) => l.cls === 'nb-md-item')).toEqual([
    { at: 0, cls: 'nb-md-item', level: 0 }, { at: 5, cls: 'nb-md-item', level: 1 },
    { at: 13, cls: 'nb-md-item', level: 0 }, { at: 17, cls: 'nb-md-item', level: 1 },
  ]);
  expect(r.marks).toContainEqual({ from: 0, to: 3, cls: 'nb-md-num' });
  expect(r.marks).toContainEqual({ from: 8, to: 11, cls: 'nb-md-num' });
  expect(r.hide).toEqual(expect.arrayContaining([[5, 8], [17, 19]]));
  expect(r.bullets).toEqual([[13, 15], [19, 21]]);
});

it('a block\'s first and last lines close its box; a hidden fence line is thin', () => {
  const doc = '```\nlet a\n```\nx';
  const r = at(doc);
  const of = (pos: number) => r.lines.filter((l) => l.at === pos).map((l) => l.cls);
  expect(of(0)).toEqual(expect.arrayContaining(['nb-md-block', 'nb-md-top', 'nb-md-fence']));
  expect(of(10)).toEqual(expect.arrayContaining(['nb-md-block', 'nb-md-bottom', 'nb-md-fence']));
  expect(at(doc, 1).lines.filter((l) => l.at === 0).map((l) => l.cls)).not.toContain('nb-md-fence');
});

it('code with no language is highlighted as the chat does, by a guess', () => {
  const r = at('```\nconst a = 1;\nfunction f() { return a; }\n```\n');
  expect(r.marks.some((m) => /hljs-/.test(m.cls))).toBe(true);
});

it('the same code is highlighted once, however often the caret moves', () => {
  const spy = vi.spyOn(hljs, 'highlight');
  const doc = '```js\nlet cached = 1\n```\n';
  at(doc);
  at(doc, 0);
  at(doc, 3);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});

it('an opened span formats what follows it up to the caret before it is closed', () => {
  expect(at('say ~~gone').marks).toContainEqual({ from: 6, to: 10, cls: 'nb-md-strike' });
  expect(at('**bo').marks).toContainEqual({ from: 2, to: 4, cls: 'nb-md-strong' });
  expect(at('an _it').marks).toContainEqual({ from: 4, to: 6, cls: 'nb-md-em' });
  expect(at('a `co').marks).toContainEqual({ from: 3, to: 5, cls: 'nb-md-code' });
});

it('no pending format: a lone mark before a space, a mark inside a word, a closed span, another line', () => {
  const pending = (doc: string, caret?: number) => at(doc, caret).marks.filter((m) => m.cls.startsWith('nb-md-') && m.cls !== 'nb-md-num');
  expect(pending('a * b')).toEqual([]);
  expect(pending('snake_case')).toEqual([]);
  expect(pending('**a** b')).toEqual([{ from: 2, to: 3, cls: 'nb-md-strong' }]);
  expect(pending('~~x\nnext')).toEqual([]);
});
