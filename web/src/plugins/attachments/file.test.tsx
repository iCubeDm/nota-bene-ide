import { afterEach, expect, it, vi } from 'vitest';
import { uploadFile } from './file.ts';

afterEach(() => vi.unstubAllGlobals());

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
