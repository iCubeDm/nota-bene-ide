import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeBackend } from '../agent/fake.ts';
import { startServer } from '../server.ts';
import { registerWindow } from '../windows.ts';
import { remoteMain } from './cli.ts';
import { Connector } from './connector.ts';
import { controlClient, type ControlClient } from './control.ts';
import { pairProof, pairTicket, parsePairUri, b64u } from './store.ts';
import { generateKeyPair } from './noise.ts';
import { relayPhone } from './testPhone.ts';
import { startRelay, type TestRelay } from './testRelay.ts';

let relay: TestRelay;
let tmp: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  relay = await startRelay();
}, 120_000);
afterAll(async () => {
  await relay?.stop();
});
beforeEach(() => {
  // short: the control socket's path must fit in sun_path (104 bytes on macOS)
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nbc-')));
  for (const d of ['dist', 'proj']) fs.mkdirSync(path.join(tmp, d));
  fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<h1>shell</h1>');
  fs.writeFileSync(path.join(tmp, 'proj', 'big.bin'), Buffer.alloc(4 * 1024 * 1024, 1));
  process.env.NOTA_BENE_HOME = path.join(tmp, 'h');
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function connector(o: { pairTtlMs?: number } = {}) {
  const c = new Connector({ relay: relay.url, backoff: { minMs: 50, maxMs: 200 }, ...o });
  await c.start();
  closers.push(() => c.stop());
  await until(() => c.online);
  return c;
}

async function client(): Promise<ControlClient> {
  const cl = await controlClient();
  closers.push(() => cl.close());
  return cl;
}

type Code = { t: 'code'; uri: string; hostFingerprint: string; expiresAt: number };
async function pairCode(): Promise<{ cl: ControlClient; code: Code }> {
  const cl = await client();
  cl.send({ op: 'pair' });
  const code = (await cl.next((m) => m.t === 'code')) as Code;
  return { cl, code };
}

/** A phone presenting a pairing code through the relay. */
function present(uri: string, name = 'Pixel') {
  const { relay: url, hostPub, secret } = parsePairUri(uri);
  const key = generateKeyPair();
  const p = relayPhone({ url, hostPub, key, ticket: pairTicket(secret), hello: { v: 1, name, pair: b64u(pairProof(secret, key.pub)) } });
  closers.push(() => p.ws.terminate());
  return p;
}

describe('connector', () => {
  it('pairs a phone through the relay; a later presenter of the same code is refused and announced', async () => {
    await connector();
    const { cl, code } = await pairCode();
    expect(code.uri.startsWith('nbremote://pair?v=1&')).toBe(true);
    expect(code.hostFingerprint).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
    const p = present(code.uri);
    await p.phone.ready;
    const paired = (await cl.next((m) => m.t === 'paired')) as { device: { id: string; name: string } };
    expect(paired.device.name).toBe('Pixel');
    const list = await client();
    list.send({ op: 'devices' });
    const devs = (await list.next((m) => 'devices' in m)) as { devices: { id: string; online: boolean }[] };
    expect(devs.devices).toEqual([expect.objectContaining({ id: paired.device.id, online: true })]);

    const late = present(code.uri, 'Other');
    await until(() => late.state.closed !== undefined);
    expect(late.phone.welcome).toBeUndefined();
    expect(await cl.next((m) => m.t === 'refused')).toEqual({ t: 'refused', fingerprint: expect.stringMatching(/^[a-z2-7]{4}-/) });
  });

  it('a second pair cancels the first; closing the pair client withdraws its code', async () => {
    await connector();
    const first = await pairCode();
    const second = await pairCode();
    await first.cl.next((m) => m.t === 'cancelled');
    const stale = present(first.code.uri);
    expect(await stale.closed).toBe(4403);
    second.cl.close();
    await new Promise((r) => setTimeout(r, 100));
    const withdrawn = present(second.code.uri);
    expect(await withdrawn.closed).toBe(4403);
  });

  it('a code expires', async () => {
    await connector({ pairTtlMs: 300 });
    // the deadline is checked against the clock around the request, never against a timer: timers drift from Date.now()
    const before = Date.now();
    const { cl, code } = await pairCode();
    const after = Date.now();
    expect(code.expiresAt).toBeGreaterThanOrEqual(before + 300);
    expect(code.expiresAt).toBeLessThanOrEqual(after + 300);
    await cl.next((m) => m.t === 'expired');
    const p = present(code.uri);
    expect(await p.closed).toBe(4403);
  });

  it('revoke cuts a phone mid-download at once', async () => {
    const s = await startServer({ cwd: path.join(tmp, 'proj'), port: 0, backend: fakeBackend([]), webDist: path.join(tmp, 'dist'), exit: () => {} });
    closers.push(() => s.close());
    const port = Number(new URL(s.url).port);
    registerWindow(port, path.join(tmp, 'proj'), process.pid);
    const c = await connector();
    await c.windows.refresh();
    const { cl, code } = await pairCode();
    const p = present(code.uri);
    await p.phone.ready;
    const { device } = (await cl.next((m) => m.t === 'paired')) as { device: { id: string } };
    const st = p.phone.open({ kind: 'http', port, method: 'GET', path: '/file?path=big.bin' });
    st.end();
    // a slow reader: one chunk every 20 ms
    st.ondata = () => new Promise((r) => setTimeout(r, 20));
    await until(() => p.phone.dataIn > 100_000);
    const rv = await client();
    rv.send({ op: 'revoke', id: device.id });
    expect(await rv.next((m) => 'ok' in m)).toMatchObject({ ok: true, device: { id: device.id } });
    await new Promise((r) => setTimeout(r, 300));
    const at = p.phone.dataIn;
    await new Promise((r) => setTimeout(r, 300));
    expect(p.phone.dataIn).toBe(at);
    expect(at).toBeLessThan(4 * 1024 * 1024);
    rv.send({ op: 'devices' });
    expect(await rv.next((m) => 'devices' in m)).toEqual({ devices: [] });
    const again = relayPhone({ url: relay.url, hostPub: parsePairUri(code.uri).hostPub, key: p.phone.key });
    expect(await again.closed).toBe(4403);
  });

  it('refuses a second start', async () => {
    await connector();
    const c2 = new Connector({ relay: relay.url });
    await expect(c2.start()).rejects.toThrow(/already running/);
  });

  it('cli: devices and revoke talk to the running connector', async () => {
    const out: string[] = [];
    const io = { out: (s: string) => void out.push(s), err: (s: string) => void out.push(s) };
    expect(await remoteMain(['devices'], io)).toBe(1);
    expect(out.join('')).toMatch(/nota-bene remote is not running/);
    out.length = 0;
    await connector();
    const { cl, code } = await pairCode();
    const p = present(code.uri);
    await p.phone.ready;
    const { device } = (await cl.next((m) => m.t === 'paired')) as { device: { id: string } };
    expect(await remoteMain(['devices'], io)).toBe(0);
    expect(out.join('')).toContain(device.id);
    expect(out.join('')).toContain('Pixel');
    out.length = 0;
    expect(await remoteMain(['revoke', 'zzzz'], io)).toBe(1);
    expect(await remoteMain(['revoke', device.id], io)).toBe(0);
    expect(out.join('')).toContain(`revoked ${device.id}`);
  });

  it('cli: without a relay the foreground run says how to set one', async () => {
    const out: string[] = [];
    const io = { out: (s: string) => void out.push(s), err: (s: string) => void out.push(s) };
    expect(await remoteMain([], io)).toBe(2);
    expect(out.join('')).toMatch(/--relay wss:\/\//);
    expect(out.join('')).toMatch(/nota-bene \.\/remote/); // a folder named remote is opened with ./remote
    expect(await remoteMain(['--relay', 'http://x'], io)).toBe(2);
  });
});
