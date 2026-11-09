// The whole path as the app will use it: a real relay, a window, the connector, pairing over the control socket, then
// the phone's streams; the relay restarting under it; and nothing of the content or the secret in any log.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeBackend } from '../agent/fake.ts';
import { startServer } from '../server.ts';
import { registerWindow } from '../windows.ts';
import { Connector } from './connector.ts';
import { controlClient } from './control.ts';
import { generateKeyPair } from './noise.ts';
import { b64u, pairProof, pairTicket, parsePairUri } from './store.ts';
import { relayPhone } from './testPhone.ts';
import { startRelay, type TestRelay } from './testRelay.ts';

const MARKER = 'remote-e2e-content-7f3a9c';
let relay: TestRelay;
let tmp: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  relay = await startRelay();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nbe-')));
  for (const d of ['dist', 'proj']) fs.mkdirSync(path.join(tmp, d));
  fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<h1>shell</h1>');
  fs.writeFileSync(path.join(tmp, 'proj', 'notes.md'), `# Notes\n\n${MARKER}\n`);
  process.env.NOTA_BENE_HOME = path.join(tmp, 'h');
}, 120_000);
afterAll(async () => {
  while (closers.length) await closers.pop()!();
  await relay?.stop();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('remote end to end', () => {
  it('pairs, proxies, survives a relay restart, and logs nothing private', async () => {
    const s = await startServer({ cwd: path.join(tmp, 'proj'), port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: path.join(tmp, 'dist'), exit: () => {} });
    closers.push(() => s.close());
    const port = Number(new URL(s.url).port);
    registerWindow(port, path.join(tmp, 'proj'), process.pid);

    const logs: string[] = [];
    const c = new Connector({ relay: relay.url, backoff: { minMs: 50, maxMs: 300 } });
    c.on('log', (m: string) => logs.push(m));
    await c.start();
    closers.push(() => c.stop());
    await c.windows.refresh();
    await until(() => c.online);

    const cl = await controlClient();
    closers.push(() => cl.close());
    cl.send({ op: 'pair' });
    const code = await cl.next((m) => m.t === 'code');
    const { relay: url, hostPub, secret } = parsePairUri(String(code.uri));
    const key = generateKeyPair();
    const p = relayPhone({ url, hostPub, key, ticket: pairTicket(secret), hello: { v: 1, name: 'Test phone', pair: b64u(pairProof(secret, key.pub)) } });
    closers.push(() => p.ws.terminate());
    await p.phone.ready;
    await cl.next((m) => m.t === 'paired');

    const host = p.phone.host();
    await until(() => host.lists.length > 0);
    expect(host.lists.at(-1)).toEqual([expect.objectContaining({ port, provider: 'claude', root: path.join(tmp, 'proj') })]);

    const tab = p.phone.ws(port, '/ws?tab=phone1');
    await until(() => tab.events.some((e) => e.kind === 'hello'));

    const info = await p.phone.http(port, 'GET', '/info');
    expect(info.status).toBe(200);
    const part = await p.phone.http(port, 'GET', '/file?path=notes.md', { headers: { range: 'bytes=9-33' } });
    expect(part.status).toBe(206);
    expect(part.body.toString()).toBe(MARKER);

    // the relay goes away and comes back: the connector reconnects, the phone reconnects as the app will
    await relay.restart();
    expect(await p.closed).not.toBe(4409);
    await until(() => c.online, 15_000);
    const p2 = relayPhone({ url, hostPub, key });
    closers.push(() => p2.ws.terminate());
    await p2.phone.ready;
    const host2 = p2.phone.host();
    await until(() => host2.lists.length > 0);
    expect(host2.lists.at(-1)?.map((w) => w.port)).toEqual([port]);

    const everything = `${logs.join('\n')}\n${relay.output()}`;
    expect(everything).not.toContain(MARKER);
    for (const form of [b64u(secret), secret.toString('hex'), b64u(pairTicket(secret))]) expect(everything).not.toContain(form);
    expect(logs.some((l) => l.startsWith('paired Test phone'))).toBe(true);
  }, 60_000);
});
