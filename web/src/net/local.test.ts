import { expect, it } from 'vitest';
import { isLocalPage } from './local.ts';

it('isLocalPage: the loopback names this server listens on (and the dev page); anything else is another machine', () => {
  for (const h of ['127.0.0.1', 'localhost', '[::1]']) expect(isLocalPage(h), h).toBe(true);
  for (const h of ['relay.example.com', '192.168.1.5', 'localhost.example.com']) expect(isLocalPage(h), h).toBe(false);
});
