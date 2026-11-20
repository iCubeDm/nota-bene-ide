import { afterEach, expect, it } from 'vitest';
import { isLocalPage, loadRemotePage, page, remotePage } from './local.ts';

afterEach(() => { page.remote = null; });

it('isLocalPage: the loopback names this server listens on (and the dev page); anything else is another machine', () => {
  for (const h of ['127.0.0.1', 'localhost', '[::1]']) expect(isLocalPage(h), h).toBe(true);
  for (const h of ['relay.example.com', '192.168.1.5', 'localhost.example.com']) expect(isLocalPage(h), h).toBe(false);
});

it('issue 297: a page a desktop proxy shows is another computer\'s, on localhost too; anything else is not', async () => {
  const answer = (body: string, status = 200) => (async () => new Response(body, { status })) as typeof fetch;
  await loadRemotePage(answer('{"host":"h1","name":"Studio"}'));
  expect(remotePage()).toEqual({ host: 'h1', name: 'Studio' });
  expect(isLocalPage('localhost')).toBe(false);
  for (const [body, status] of [['null', 200], ['<h1>shell</h1>', 200], ['', 401], ['{"host":1}', 200]] as const) {
    await loadRemotePage(answer(body, status));
    expect(remotePage(), body).toBeNull();
  }
  expect(isLocalPage('localhost')).toBe(true);
});
