import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBackend } from '../agent/fake.ts';
import { verifiedBearer } from '../auth.ts';
import { startServer } from '../server.ts';
import { CONTROL_HEADER, controlToken } from '../system.ts';
import { HOST_WINDOW_INFO } from '@nota-bene/shared';
import { registerWindow, windowKey } from '../windows.ts';
import { cleanName, computerName, DeviceChannel, goodPath } from './device.ts';
import { Windows, type ProvedWindow } from './discover.ts';
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
  const s = await startServer({ cwd: path.join(tmp, 'proj'), port, backend: fakeBackend([{ text: 'hello' }]), backends: () => fakeBackend([]), webDist: path.join(tmp, 'dist'), takeoverGraceMs: 40, exit: () => {} });
  const p = Number(new URL(s.url).port);
  registerWindow(p, path.join(tmp, 'proj'), process.pid);
  let open = true;
  const close = async () => {
    if (open) await s.close();
    open = false;
  };
  closers.push(close);
  // its launch agent (issue 639: the top is the server's home; the phone opens an agent under its prefix)
  const agent = ((await (await fetch(`${s.url}/info`, { headers: { authorization: (await verifiedBearer(p, 2000))! } })).json()) as { agents: { id: string }[] }).agents[0]!.id;
  return { port: p, close, agent, at: `/a/${agent}` };
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
    // the project switcher's routes start windows and hand out other windows' logins: the desktop only, until phase 2
    for (const p of ['/system/projects', '/system/projects/open', '/system/projects/create', '/system/projects/enter', '/system/projects/sessions', '/system/folders', '/system/agents', '/system/remote/open', '/System/Remote', '/mcp', '/a/claude-abcdef/mcp']) expect(goodPath(p)).toBe(false);
    // issue 461: Show in Finder / Open act on this computer's desktop: never from the phone
    for (const p of ['/os/reveal', '/os/open', '/OS/open', '/os?x']) expect(goodPath(p)).toBe(false);
    expect(goodPath('/osx.md')).toBe(true);
    expect(goodPath('/system/windows')).toBe(true);
    for (const p of ['/remotely.md', '/file?path=remote/a.md', '/info']) expect(goodPath(p)).toBe(true);
    // epic 383: an agent's prefix comes off before the rules, as the window takes it off
    for (const p of ['/a/claude-abcdef/control/stop', '/a/claude-abcdef/remote/pair', '/a/x/system/projects/open', '/a/x/os/open', '/a/claude-abcdef/REMOTE', '/a/x//evil.example/y', '/a/x/\\y']) expect(goodPath(p), p).toBe(false);
    for (const p of ['/a/claude-abcdef/info', '/a/claude-abcdef/ws?tab=1', '/a/claude-abcdef', '/a/claude-abcdef/file?path=control/a.md']) expect(goodPath(p), p).toBe(true);
    for (const p of ['/system/shortcut/install', '/a/claude-abcdef/system/shortcut/install', '/system/shortcut']) expect(goodPath(p), p).toBe(false);
  });

  it('the computer name loses control and bidi-override characters and is capped at 64', () => {
    expect(computerName('stu\u0000dio\u202E-mac\n')).toBe('studio-mac');
    expect(computerName('\u202E\u0007')).toBeUndefined();
    expect(computerName('a'.repeat(100))).toBe('a'.repeat(64));
    expect(computerName('😀'.repeat(100))).toBe('😀'.repeat(64));
    // a name another device or computer sent is cleaned the same way, but keeps its .local (issue 297)
    expect(cleanName('\u202eStudio\u0000.local')).toBe('Studio.local');
    expect(cleanName(' \u2066 ')).toBeUndefined();
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
    first.phone.hello({ v: 1, name: '\u202ePi\u0007xel\n', pair: b64u(pairProof(secret, first.phone.key.pub)) });
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

  it('the host stream lists a server\'s other agents apart, each with its agent id and its folder\'s id (epic 383)', async () => {
    const a = await window();
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    const opened = await fetch(`http://127.0.0.1:${a.port}/control/open`, { method: 'POST', headers: { [CONTROL_HEADER]: controlToken() }, body: JSON.stringify({ root: other }) });
    const { agent } = await opened.json() as { agent: string };
    const l = await paired(await windows());
    const h = l.phone.host();
    await until(() => h.agents.some((x) => x.length > 0));
    const i = h.agents.findIndex((x) => x.length > 0);
    // the server by its first agent, under its prefix too (issue 639)
    expect(h.lists[i]).toEqual([expect.objectContaining({ port: a.port, root: path.join(tmp, 'proj'), agent: a.agent })]);
    expect(h.agents[i]).toEqual([expect.objectContaining({ id: windowKey('claude', other), port: a.port, agent, provider: 'claude', root: other, replies: 0 })]);
    // its streams go under its prefix
    const info = await l.phone.http(a.port, 'GET', `/a/${agent}/info`);
    expect(JSON.parse(info.body.toString())).toMatchObject({ agent, root: other });
  });

  it('the host stream gives each window its stable id and only the /info fields of the host stream (issue 511)', async () => {
    const a = await window();
    const l = await paired(await windows());
    const h = l.phone.host();
    await until(() => h.lists.length > 0);
    const w = h.lists[0]![0]!;
    expect(w).toMatchObject({ id: windowKey('claude', path.join(tmp, 'proj')), port: a.port });
    // /info says more (clients, codeChanged, restartPending, unseen): for other windows, not for the phone
    expect(Object.keys(w).filter((k) => !['id', 'port', 'agent', 'provider', 'root', ...HOST_WINDOW_INFO].includes(k))).toEqual([]);
  });

  /** Windows of stub launches whose /info fails (a 500 on an ephemeral port): what `list()` gives is all there is. */
  async function stubWindows() {
    const ports: number[] = [];
    for (let i = 0; i < 3; i++) {
      const srv = http.createServer((_q, r) => r.writeHead(500).end());
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      closers.push(() => new Promise<void>((r) => srv.close(() => r())));
      ports.push((srv.address() as AddressInfo).port);
    }
    ports.sort((x, y) => x - y);
    let list: ProvedWindow[] = [];
    const ev = new EventEmitter();
    const stub = Object.assign(ev, { list: () => list, get: (p: number) => list.find((w) => w.port === p) }) as unknown as Windows;
    const set = (next: { port: number; root: string; provider?: 'claude' | 'codex' }[]) => {
      list = next.map((w) => ({ provider: 'claude', bearer: 'Bearer x', nonce: 'n', ...w }));
      ev.emit('change', list);
    };
    return { ports, stub, set };
  }

  it('a window that restarts on another port keeps its id', async () => {
    const { ports: [p1, p2], stub, set } = await stubWindows();
    set([{ port: p1!, root: '/p' }]);
    const l = await paired(stub);
    const h = l.phone.host();
    await until(() => h.lists.length > 0);
    set([{ port: p2!, root: '/p' }]);
    await until(() => h.lists.length > 1);
    expect(h.lists.map((x) => x[0])).toEqual([
      { id: windowKey('claude', '/p'), port: p1, provider: 'claude', root: '/p' },
      { id: windowKey('claude', '/p'), port: p2, provider: 'claude', root: '/p' },
    ]);
  });

  it('two windows of one folder and agent: the lower port keeps the bare id, the other gets `<id>:<port>`', async () => {
    const { ports: [p1, p2, p3], stub, set } = await stubWindows();
    set([{ port: p1!, root: '/p' }, { port: p2!, root: '/p' }, { port: p3!, root: '/p', provider: 'codex' }]);
    const l = await paired(stub);
    const h = l.phone.host();
    await until(() => h.lists.length > 0);
    const id = windowKey('claude', '/p');
    expect(h.lists[0]!.map((w) => w.id)).toEqual([id, `${id}:${p2}`, windowKey('codex', '/p')]);
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
    const put = await l.phone.http(a.port, 'PUT', `${a.at}/project-icon`, { headers: { 'content-type': 'image/png' }, body: png });
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
    const put = await l.phone.http(a.port, 'PUT', `${a.at}/project-icon`, { headers: { 'content-type': 'image/png' }, body: png });
    expect(put.status).toBe(200);
    const got = await l.phone.http(a.port, 'GET', `${a.at}/project-icon`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(png);
    expect(got.headers.etag).toBe(`"${(JSON.parse(put.body.toString()) as { icon: string }).icon}"`);
    expect((await l.phone.http(a.port, 'DELETE', `${a.at}/project-icon`)).status).toBe(204);
    expect((await l.phone.http(a.port, 'GET', `${a.at}/project-icon`)).status).toBe(404);
  });

  it('a ws stream is a tab of the window, one-tab rule included', async () => {
    const a = await window();
    const l = await paired(await windows());
    const t1 = l.phone.ws(a.port, `${a.at}/ws?tab=t1`);
    await until(() => t1.events.some((e) => e.kind === 'hello'));
    const t2 = l.phone.ws(a.port, `${a.at}/ws?tab=t2`);
    await until(() => t2.events.some((e) => e.kind === 'hello'));
    expect(t2.events.map((e) => e.kind)).toContain('occupied');
    t2.send({ type: 'takeover' });
    expect((await t1.closed).code).toBe(4001);
    t2.send({ type: 'send', id: 'u1', text: 'from the phone' });
    await until(() => t2.events.some((e) => e.kind === 'user' && e.id === 'u1'));
  });

  it('under the agent\'s prefix (epic 383): the same window, the same refusals', async () => {
    const a = await window();
    const l = await paired(await windows());
    const id = a.agent;
    expect((await l.phone.http(a.port, 'GET', `/a/${id}/info`)).status).toBe(200);
    await expect(l.phone.http(a.port, 'GET', `/a/${id}/control/stop`)).rejects.toMatchObject({ code: 4900 });
    await expect(l.phone.http(a.port, 'POST', `/a/${id}/remote/pair`)).rejects.toMatchObject({ code: 4900 });
    const t = l.phone.ws(a.port, `/a/${id}/ws?tab=t1`);
    await until(() => t.events.some((e) => e.kind === 'hello'));
  });

  it('http: GET, Range, a write, and refused paths', async () => {
    const a = await window();
    const l = await paired(await windows());
    const info = await l.phone.http(a.port, 'GET', `${a.at}/info`);
    expect(info.status).toBe(200);
    expect(JSON.parse(info.body.toString()).root).toBe(path.join(tmp, 'proj'));
    const part = await l.phone.http(a.port, 'GET', `${a.at}/file?path=a.txt`, { headers: { range: 'bytes=0-9', cookie: 'x=1' } });
    expect(part.status).toBe(206);
    expect(part.body.toString()).toBe('0123456789');
    // issue 461: Download through the relay saves under the file's name; Show in Finder never goes through
    const dl = await l.phone.http(a.port, 'GET', `${a.at}/file?path=a.txt&download=1`);
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="a.txt"; filename*=UTF-8''a.txt`);
    await expect(l.phone.http(a.port, 'POST', `${a.at}/os/reveal`, { headers: { 'content-type': 'application/json' }, body: Buffer.from('{"path":"a.txt"}') })).rejects.toMatchObject({ code: 4900 });
    const post = await l.phone.http(a.port, 'POST', `${a.at}/system/prefs`, { headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ updateCheck: false })) });
    expect(post.status).toBe(200);
    expect(post.headers['set-cookie']).toBeUndefined();
    await expect(l.phone.http(a.port, 'GET', '/control/stop')).rejects.toMatchObject({ code: 4900 });
    await expect(l.phone.http(a.port, 'POST', '/remote/pair')).rejects.toMatchObject({ code: 4900 });
    await expect(l.phone.http(a.port, 'GET', '//evil.example/x')).rejects.toMatchObject({ code: 4900 });
    await expect(l.phone.http(a.port + 1, 'GET', '/info')).rejects.toMatchObject({ code: 4904 });
    const ws = l.phone.ws(a.port, `${a.at}/info`);
    expect((await ws.closed).code).toBe(4900);
  });

  it('a path that is not plain ASCII closes that stream, nothing more', async () => {
    const a = await window();
    const l = await paired(await windows());
    await expect(l.phone.http(a.port, 'GET', `${a.at}/file?path=заметки.md`)).rejects.toMatchObject({ code: 4900 });
    await expect(l.phone.http(a.port, 'GET', `${a.at}/file?path=a\u0001.md`)).rejects.toMatchObject({ code: 4900 });
    expect((await l.phone.ws(a.port, `${a.at}/ws?tab=t#x`).closed).code).toBe(4900);
    fs.writeFileSync(path.join(tmp, 'proj', 'а.txt'), 'cyrillic name');
    expect((await l.phone.http(a.port, 'GET', `${a.at}/file?path=%D0%B0.txt`)).body.toString()).toBe('cyrillic name');
    expect(l.dropped()).toBe(false);
    expect((await l.phone.http(a.port, 'GET', `${a.at}/info`)).status).toBe(200);
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
    const t1 = l.phone.ws(a.port, `${a.at}/ws?tab=t1`);
    await until(() => t1.events.some((e) => e.kind === 'hello'));
    await a.close();
    expect((await t1.closed).code).toBe(4904);
    const b = await window(a.port); // a fresh launch: its agent is another
    const info = await l.phone.http(a.port, 'GET', `${b.at}/info`);
    expect(info.status).toBe(200);
  });

  it('a phone that stops reading holds the host to the connection window; another phone carries on', async () => {
    const a = await window();
    const w = await windows();
    const slow = await paired(w);
    const s = slow.phone.open({ kind: 'http', port: a.port, method: 'GET', path: `${a.at}/file?path=big.bin` });
    s.end();
    s.ondata = () => new Promise(() => {});
    const fast = await paired(w);
    const got = await fast.phone.http(a.port, 'GET', `${a.at}/file?path=big.bin`);
    expect(got.body.length).toBe(BIG);
    expect(got.body[BIG - 1]).toBe((BIG - 1) % 251);
    await new Promise((r) => setTimeout(r, 100));
    expect(slow.phone.dataIn).toBeGreaterThan(0);
    expect(slow.phone.dataIn).toBeLessThanOrEqual(CONN_WINDOW);
    // and the host stopped reading from the window instead of queueing the rest of the file
    expect(slow.channel.queuedBytes).toBeLessThan(256 * 1024);
  });
});

it('epic 383: a forwarded socket never follows the launcher (go is dropped); the rest of the query stays', async () => {
  const { forwardedWsPath } = await import('./device.ts');
  expect(forwardedWsPath('/ws?tab=t&pause=1&held=1&go=1')).toBe('/ws?tab=t&pause=1&held=1');
  expect(forwardedWsPath('/a/codex-abcdef/ws?go=1&tab=t')).toBe('/a/codex-abcdef/ws?tab=t');
  expect(forwardedWsPath('/ws')).toBe('/ws');
});
