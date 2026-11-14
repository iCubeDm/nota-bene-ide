import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBackend } from '../agent/fake.ts';
import { startServer } from '../server.ts';
import { registerWindow } from '../windows.ts';
import { computerName, DeviceChannel, goodPath } from './device.ts';
import { Windows } from './discover.ts';
import { CONN_WINDOW } from './mux.ts';
import { generateKeyPair, type KeyPair } from './noise.ts';
import { b64u, hostKey, pairProof } from './store.ts';
import { Phone } from './testPhone.ts';

let tmp: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void> | void)[] = [];
const BIG = 2 * 1024 * 1024;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-dev-')));
  fs.mkdirSync(path.join(tmp, 'dist'));
  fs.mkdirSync(path.join(tmp, 'proj'));
  fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<h1>shell</h1>');
  fs.writeFileSync(path.join(tmp, 'proj', 'a.txt'), '0123456789abcdefghij');
  const big = Buffer.alloc(BIG);
  for (let i = 0; i < BIG; i++) big[i] = i % 251;
  fs.writeFileSync(path.join(tmp, 'proj', 'big.bin'), big);
  process.env.NOTA_BENE_HOME = path.join(tmp, 'home');
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
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function window(port = 0) {
  const s = await startServer({ cwd: path.join(tmp, 'proj'), port, backend: fakeBackend([{ text: 'hello' }]), webDist: path.join(tmp, 'dist'), takeoverGraceMs: 40, exit: () => {} });
  const p = Number(new URL(s.url).port);
  registerWindow(p, path.join(tmp, 'proj'), process.pid);
  let open = true;
  const close = async () => {
    if (open) await s.close();
    open = false;
  };
  closers.push(close);
  return { port: p, close };
}

async function windows() {
  const w = new Windows({ pollMs: 60_000 });
  await w.start();
  closers.push(() => w.stop());
  return w;
}

type Link = { phone: Phone; channel: DeviceChannel; dropped: () => boolean };
function link(o: { windows: Windows; host: KeyPair; listed?: Set<string>; secret?: Buffer; onPaired?: (pub: Buffer, name?: string) => boolean; key?: KeyPair; expectHash?: string; hostName?: string }): Link {
  let dropped = false;
  let phone!: Phone;
  const channel = new DeviceChannel({
    hostKey: o.host,
    send: (b) => queueMicrotask(() => { try { phone.receive(b); } catch { /* a dead phone */ } }),
    drop: () => (dropped = true),
    windows: o.windows,
    pairing: () => (o.secret ? { secret: o.secret } : null),
    onPaired: o.onPaired ?? (() => true),
    isListed: (pub) => o.listed?.has(b64u(pub)) ?? false,
    ...(o.expectHash ? { deviceHash: o.expectHash } : {}),
    ...(o.hostName ? { hostName: o.hostName } : {}),
  });
  phone = new Phone({ hostPub: o.host.pub, ...(o.key ? { key: o.key } : {}), send: (b) => queueMicrotask(() => channel.receive(b)) });
  closers.push(() => channel.close());
  return { phone, channel, dropped: () => dropped };
}

/** A listed phone with a finished handshake. */
async function paired(w: Windows) {
  const key = generateKeyPair();
  const l = link({ windows: w, host: hostKey(), listed: new Set([b64u(key.pub)]), key });
  l.phone.hello();
  await l.phone.ready;
  return l;
}

describe('device channel', () => {
  it('a listed phone completes the handshake', async () => {
    const l = await paired(await windows());
    expect(l.phone.welcome).toMatchObject({ v: 1, ok: true });
    expect(l.channel.devicePub?.equals(l.phone.key.pub)).toBe(true);
  });

  it('the welcome names the computer when the host has a name', async () => {
    const key = generateKeyPair();
    const l = link({ windows: await windows(), host: hostKey(), listed: new Set([b64u(key.pub)]), key, hostName: 'studio-mac' });
    l.phone.hello();
    await l.phone.ready;
    expect(l.phone.welcome).toEqual({ v: 1, ok: true, host: 'studio-mac' });
  });

  it('the computer name loses a trailing .local and an empty one is left out', () => {
    expect(computerName('studio-mac.local')).toBe('studio-mac');
    expect(computerName('Studio.Local')).toBe('Studio');
    expect(computerName('build.example.net')).toBe('build.example.net');
    expect(computerName('.local')).toBeUndefined();
    expect(computerName('  ')).toBeUndefined();
  });

  it('a phone reaches no remote-access route: it would pair, revoke or switch access off unseen', () => {
    for (const p of ['/remote', '/remote/pair', '/remote/config', '/remote?x=1', '/REMOTE/revoke', '/control']) expect(goodPath(p)).toBe(false);
    for (const p of ['/remotely.md', '/file?path=remote/a.md', '/info']) expect(goodPath(p)).toBe(true);
  });

  it('the computer name loses control and bidi-override characters and is capped at 64', () => {
    expect(computerName('stu\u0000dio\u202E-mac\n')).toBe('studio-mac');
    expect(computerName('\u202E\u0007')).toBeUndefined();
    expect(computerName('a'.repeat(100))).toBe('a'.repeat(64));
    expect(computerName('😀'.repeat(100))).toBe('😀'.repeat(64));
  });

  it('an unlisted phone without a proof is dropped without an answer', async () => {
    const l = link({ windows: await windows(), host: hostKey() });
    l.phone.hello();
    await until(() => l.dropped());
    expect(l.phone.welcome).toBeUndefined();
  });

  it('a pairing proof adds the phone; one after the code was used is dropped', async () => {
    const w = await windows();
    const secret = Buffer.alloc(32, 7);
    let used = false;
    const added: [string, string | undefined][] = [];
    const onPaired = (pub: Buffer, name?: string) => {
      if (used) return false;
      used = true;
      added.push([b64u(pub), name]);
      return true;
    };
    const first = link({ windows: w, host: hostKey(), secret, onPaired });
    first.phone.hello({ v: 1, name: 'Pixel', pair: b64u(pairProof(secret, first.phone.key.pub)) });
    await first.phone.ready;
    expect(added).toEqual([[b64u(first.phone.key.pub), 'Pixel']]);

    const late = link({ windows: w, host: hostKey(), secret, onPaired });
    late.phone.hello({ v: 1, pair: b64u(pairProof(secret, late.phone.key.pub)) });
    await until(() => late.dropped());

    const wrong = link({ windows: w, host: hostKey(), secret, onPaired: () => true });
    wrong.phone.hello({ v: 1, pair: b64u(pairProof(Buffer.alloc(32, 8), wrong.phone.key.pub)) });
    await until(() => wrong.dropped());
  });

  it('the host stream lists the windows', async () => {
    const a = await window();
    const l = await paired(await windows());
    const h = l.phone.host();
    await until(() => h.lists.length > 0);
    expect(h.lists[0]).toEqual([expect.objectContaining({ port: a.port, provider: 'claude', root: path.join(tmp, 'proj') })]);
  });

  it('the host stream passes the pending, last and replies of a window', async () => {
    const a = await window();
    const l = await paired(await windows());
    const h = l.phone.host();
    await until(() => h.lists.length > 0);
    expect(h.lists[0]![0]).toMatchObject({ port: a.port, pending: false, last: null, replies: 0 });
  });

  it('the host stream forwards the icon of a window: null, then its version', async () => {
    const a = await window();
    const l = await paired(await windows());
    const h = l.phone.host();
    await until(() => h.lists.length > 0);
    expect(h.lists[0]![0]).toMatchObject({ port: a.port, icon: null });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pic')]);
    const put = await l.phone.http(a.port, 'PUT', '/project-icon', { headers: { 'content-type': 'image/png' }, body: png });
    const { icon } = JSON.parse(put.body.toString()) as { icon: string };
    expect(icon).toMatch(/^[0-9a-f]{16}$/);
    // a host stream lists the windows when it opens: a phone that asks again sees the version
    const again = l.phone.host();
    await until(() => again.lists.some((x) => x[0]?.icon === icon));
  });

  it('the project icon through the connector: PUT arrives with its Origin (200), GET and DELETE too', async () => {
    const a = await window();
    const l = await paired(await windows());
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pic')]);
    // the window refuses a non-GET without an allowed Origin, so a 200 shows the connector added it
    const put = await l.phone.http(a.port, 'PUT', '/project-icon', { headers: { 'content-type': 'image/png' }, body: png });
    expect(put.status).toBe(200);
    const got = await l.phone.http(a.port, 'GET', '/project-icon');
    expect(got.status).toBe(200);
    expect(got.body).toEqual(png);
    expect(got.headers.etag).toBe(`"${(JSON.parse(put.body.toString()) as { icon: string }).icon}"`);
    expect((await l.phone.http(a.port, 'DELETE', '/project-icon')).status).toBe(204);
    expect((await l.phone.http(a.port, 'GET', '/project-icon')).status).toBe(404);
  });

  it('a ws stream is a tab of the window, one-tab rule included', async () => {
    const a = await window();
    const l = await paired(await windows());
    const t1 = l.phone.ws(a.port, '/ws?tab=t1');
    await until(() => t1.events.some((e) => e.kind === 'hello'));
    const t2 = l.phone.ws(a.port, '/ws?tab=t2');
    await until(() => t2.events.some((e) => e.kind === 'hello'));
    expect(t2.events.map((e) => e.kind)).toContain('occupied');
    t2.send({ type: 'takeover' });
    expect((await t1.closed).code).toBe(4001);
    t2.send({ type: 'send', id: 'u1', text: 'from the phone' });
    await until(() => t2.events.some((e) => e.kind === 'user' && e.id === 'u1'));
  });

  it('http: GET, Range, a write, and refused paths', async () => {
    const a = await window();
    const l = await paired(await windows());
    const info = await l.phone.http(a.port, 'GET', '/info');
    expect(info.status).toBe(200);
    expect(JSON.parse(info.body.toString()).root).toBe(path.join(tmp, 'proj'));
    const part = await l.phone.http(a.port, 'GET', '/file?path=a.txt', { headers: { range: 'bytes=0-9', cookie: 'x=1' } });
    expect(part.status).toBe(206);
    expect(part.body.toString()).toBe('0123456789');
    const post = await l.phone.http(a.port, 'POST', '/system/prefs', { headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ updateCheck: false })) });
    expect(post.status).toBe(200);
    expect(post.headers['set-cookie']).toBeUndefined();
    await expect(l.phone.http(a.port, 'GET', '/control/stop')).rejects.toMatchObject({ code: 4900 });
    await expect(l.phone.http(a.port, 'POST', '/remote/pair')).rejects.toMatchObject({ code: 4900 });
    await expect(l.phone.http(a.port, 'GET', '//evil.example/x')).rejects.toMatchObject({ code: 4900 });
    await expect(l.phone.http(a.port + 1, 'GET', '/info')).rejects.toMatchObject({ code: 4904 });
    const ws = l.phone.ws(a.port, '/info');
    expect((await ws.closed).code).toBe(4900);
  });

  it('a path that is not plain ASCII closes that stream, nothing more', async () => {
    const a = await window();
    const l = await paired(await windows());
    await expect(l.phone.http(a.port, 'GET', '/file?path=заметки.md')).rejects.toMatchObject({ code: 4900 });
    await expect(l.phone.http(a.port, 'GET', '/file?path=a\u0001.md')).rejects.toMatchObject({ code: 4900 });
    expect((await l.phone.ws(a.port, '/ws?tab=t#x').closed).code).toBe(4900);
    fs.writeFileSync(path.join(tmp, 'proj', 'а.txt'), 'cyrillic name');
    expect((await l.phone.http(a.port, 'GET', '/file?path=%D0%B0.txt')).body.toString()).toBe('cyrillic name');
    expect(l.dropped()).toBe(false);
    expect((await l.phone.http(a.port, 'GET', '/info')).status).toBe(200);
  });

  it('a phone whose key is not the one the relay named is dropped', async () => {
    const key = generateKeyPair();
    const l = link({ windows: await windows(), host: hostKey(), listed: new Set([b64u(key.pub)]), key, expectHash: 'x'.repeat(43) });
    l.phone.hello();
    await until(() => l.dropped());
  });

  it('a POST is not sent twice when the window drops the connection', async () => {
    let posts = 0;
    const srv = http.createServer((req) => {
      posts++;
      req.socket.destroy();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise<void>((r) => srv.close(() => r())));
    const port = (srv.address() as AddressInfo).port;
    const w = { port, provider: 'claude' as const, root: tmp, bearer: 'Bearer x', nonce: 'n' };
    const stub = { get: () => w, list: () => [w], reprove: async () => w, on() {}, off() {} } as unknown as Windows;
    const key = generateKeyPair();
    const l = link({ windows: stub, host: hostKey(), listed: new Set([b64u(key.pub)]), key });
    l.phone.hello();
    await l.phone.ready;
    await expect(l.phone.http(port, 'POST', '/send', { body: Buffer.from('{}') })).rejects.toMatchObject({ code: 4902 });
    expect(posts).toBe(1);
  });

  it('a window that restarted on its port: http is re-proved, an open ws stream closes', async () => {
    const a = await window();
    const l = await paired(await windows());
    const t1 = l.phone.ws(a.port, '/ws?tab=t1');
    await until(() => t1.events.some((e) => e.kind === 'hello'));
    await a.close();
    expect((await t1.closed).code).toBe(4904);
    await window(a.port);
    const info = await l.phone.http(a.port, 'GET', '/info');
    expect(info.status).toBe(200);
  });

  it('a phone that stops reading holds the host to the connection window; another phone carries on', async () => {
    const a = await window();
    const w = await windows();
    const slow = await paired(w);
    const s = slow.phone.open({ kind: 'http', port: a.port, method: 'GET', path: '/file?path=big.bin' });
    s.end();
    s.ondata = () => new Promise(() => {});
    const fast = await paired(w);
    const got = await fast.phone.http(a.port, 'GET', '/file?path=big.bin');
    expect(got.body.length).toBe(BIG);
    expect(got.body[BIG - 1]).toBe((BIG - 1) % 251);
    await new Promise((r) => setTimeout(r, 100));
    expect(slow.phone.dataIn).toBeGreaterThan(0);
    expect(slow.phone.dataIn).toBeLessThanOrEqual(CONN_WINDOW);
    // and the host stopped reading from the window instead of queueing the rest of the file
    expect(slow.channel.queuedBytes).toBeLessThan(256 * 1024);
  });
});
