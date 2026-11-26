import { expect, it } from 'vitest';
import type { Field } from '../components/field/field.ts';
import { insertPaths, pathText } from './insertText.ts';

it('pathText: media as an embed (it plays in the feed), anything else as code (a ref); never an @mention', () => {
  expect(pathText('attachments/a.mp3')).toBe('![](attachments/a.mp3)');
  expect(pathText('clips/my take.mp4')).toBe('![](<clips/my take.mp4>)');
  expect(pathText('img/x.png')).toBe('![](img/x.png)');
  expect(pathText('attachments/a.zip')).toBe('`attachments/a.zip`');
  expect(pathText('a (1).mp4')).toBe('![](<a (1).mp4>)');
});

it('pathText: the awkward names (issue 461 review)', () => {
  // a backtick inside: a longer fence; at an edge: padded, so the span keeps it
  expect(pathText('odd`name.txt')).toBe('``odd`name.txt``');
  expect(pathText('`edge.txt')).toBe('`` `edge.txt ``');
  expect(pathText('a``b.txt')).toBe('```a``b.txt```');
  // a literal %20 in a name stays that name (the feed decodes the embed's URL once)
  expect(pathText('clips/a%20b.mp4')).toBe('![](clips/a%2520b.mp4)');
  // < or > cannot sit in an embed: code instead
  expect(pathText('clips/<x>.mp4')).toBe('`clips/<x>.mp4`');
  // what a code span would not make a ref (a root file without an extension, a long extension): a link, which always is
  expect(pathText('Makefile')).toBe('[Makefile](<Makefile>)');
  expect(pathText('data.parquetx')).toBe('[data.parquetx](<data.parquetx>)');
  expect(pathText('100%.weird1')).toBe('[100%.weird1](<100%25.weird1>)');
});

it('the forms render as refs and players', async () => {
  const { renderWith } = await import('@/core/testing');
  const { Markdown } = await import('@/core/components/markdown/Markdown.tsx');
  const { escapeMentions } = await import('@/core/refs/refs.ts');
  const text = ['clips/a%20b.mp4', 'Makefile', '`edge.txt'].map(pathText).join(' ');
  const { container } = renderWith(<Markdown text={escapeMentions(text)} final breaks mentions noHtml />);
  expect(container.querySelector('video')?.getAttribute('src')).toBe('/file?path=clips%2Fa%2520b.mp4');
  expect(container.querySelector('a.ref')).toHaveAttribute('data-path', 'Makefile');
  expect(container.querySelector('code')?.textContent).toBe('`edge.txt');
});

it('insertPaths: at the caret (over a selection), spaced from the words around it, the caret after', async () => {
  const { render } = await import('@testing-library/react');
  const { EditorField } = await import('@/core/components/field/EditorField.tsx');
  const { setValue, select } = await import('@/core/testing');
  const ref: { current: Field | null } = { current: null };
  const seen: string[] = [];
  render(<EditorField fieldRef={ref} value="" onChange={(v) => seen.push(v)} newline="Enter" ariaLabel="m" />);
  const f = ref.current!;
  setValue(f.element, 'see now');
  select(f.element, 3);
  seen.length = 0;
  insertPaths(f, ['a.zip', 'b.zip']);
  expect(f.text()).toBe('see `a.zip` `b.zip` now');
  expect(f.selection().from).toBe('see `a.zip` `b.zip`'.length);
  expect(seen).toHaveLength(1);
  setValue(f.element, '');
  insertPaths(f, ['c.zip']);
  expect(f.text()).toBe('`c.zip`');
  setValue(f.element, 'x ');
  select(f.element, 2);
  insertPaths(f, ['c.zip']);
  expect(f.text()).toBe('x `c.zip`');
});
