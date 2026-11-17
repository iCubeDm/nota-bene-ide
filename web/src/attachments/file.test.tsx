import { afterEach, expect, it, vi } from 'vitest';
import { insertPaths, pathText, uploadFile } from './file.ts';

afterEach(() => vi.unstubAllGlobals());

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
  const { render } = await import('@testing-library/react');
  const { Markdown } = await import('@/feed/Markdown.tsx');
  const { escapeMentions } = await import('@/refs/refs.ts');
  const text = ['clips/a%20b.mp4', 'Makefile', '`edge.txt'].map(pathText).join(' ');
  const { container } = render(<Markdown text={escapeMentions(text)} final breaks mentions noHtml />);
  expect(container.querySelector('video')?.getAttribute('src')).toBe('/file?path=clips%2Fa%2520b.mp4');
  expect(container.querySelector('a.ref')).toHaveAttribute('data-path', 'Makefile');
  expect(container.querySelector('code')?.textContent).toBe('`edge.txt');
});

it('insertPaths: at the caret (over a selection), spaced from the words around it, the caret after', () => {
  const ta = document.createElement('textarea');
  const seen: string[] = [];
  ta.addEventListener('input', () => seen.push(ta.value));
  ta.value = 'see now';
  ta.setSelectionRange(3, 3);
  insertPaths(ta, ['a.zip', 'b.zip']);
  expect(ta.value).toBe('see `a.zip` `b.zip` now');
  expect(ta.selectionStart).toBe('see `a.zip` `b.zip`'.length);
  expect(seen).toHaveLength(1);
  ta.value = '';
  insertPaths(ta, ['c.zip']);
  expect(ta.value).toBe('`c.zip`');
  ta.value = 'x ';
  ta.setSelectionRange(2, 2);
  insertPaths(ta, ['c.zip']);
  expect(ta.value).toBe('x `c.zip`');
});

it('uploadFile streams the File as the body with its name in the query, through the key', async () => {
  const f = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(JSON.stringify({ path: 'attachments/a b.zip' })));
  vi.stubGlobal('fetch', f);
  const file = new File(['x'], 'a b.zip', { type: 'application/zip' });
  expect(await uploadFile(file)).toBe('attachments/a b.zip');
  expect(f.mock.calls[0]![0]).toBe('/attach-file?name=a%20b.zip');
  expect(f.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: file });
  f.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'attachments-not-folder' }), { status: 409 }));
  await expect(uploadFile(file)).rejects.toMatchObject({ code: 'attachments-not-folder', status: 409 });
  const ac = new AbortController();
  await uploadFile(file, ac.signal);
  expect(f.mock.calls.at(-1)![1]).toMatchObject({ signal: ac.signal });
});
