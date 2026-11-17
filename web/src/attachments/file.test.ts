import { afterEach, expect, it, vi } from 'vitest';
import { insertPaths, pathText, uploadFile } from './file.ts';

afterEach(() => vi.unstubAllGlobals());

it('pathText: media as an embed (it plays in the feed), anything else as code (a ref); never an @mention', () => {
  expect(pathText('attachments/a.mp3')).toBe('![](attachments/a.mp3)');
  expect(pathText('clips/my take.mp4')).toBe('![](<clips/my take.mp4>)');
  expect(pathText('img/x.png')).toBe('![](img/x.png)');
  expect(pathText('attachments/a.zip')).toBe('`attachments/a.zip`');
  expect(pathText('odd`name.txt')).toBe('``odd`name.txt``');
  expect(pathText('a (1).mp4')).toBe('![](<a (1).mp4>)');
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
  f.mockResolvedValueOnce(new Response('no', { status: 413 }));
  await expect(uploadFile(file)).rejects.toThrow();
});
