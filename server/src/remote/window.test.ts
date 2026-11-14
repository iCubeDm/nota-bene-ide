import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RemoteState, ServerEvent } from '@nota-bene/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fakeBackend } from '../agent/fake.ts';
import { startServer } from '../server.ts';
import { RemoteKeeper } from './keeper.ts';

let home: string;
let dist: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-rwin-home-'));
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-rwin-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

async function boot(remote?: RemoteKeeper) {
  const s = await startServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: dist, oneTab: false, ...(remote ? { remote } : {}) });
  closers.push(s.close);
  return s;
}

async function connect(url: string): Promise<ServerEvent[]> {
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws');
  const events: ServerEvent[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  closers.push(() => void ws.terminate());
  return events;
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('remote access in a window', () => {
  it('a socket gets the remote state on attach and on every change, and the outcome of a pairing', async () => {
    const keeper = new RemoteKeeper({ pollMs: 3_600_000 });
    const s = await boot(keeper);
    const events = await connect(s.url);
    await until(() => events.some((e) => e.kind === 'remote'));
    expect(events.find((e) => e.kind === 'remote')).toMatchObject({ state: { configured: false, running: false } });
    const next: RemoteState = { ...keeper.state(), configured: true, relay: 'wss://relay.example.com' };
    keeper.emit('state', next);
    keeper.emit('pair', { result: 'expired' });
    await until(() => events.some((e) => e.kind === 'remote-pair'));
    expect(events.filter((e) => e.kind === 'remote').at(-1)).toEqual({ kind: 'remote', state: next });
    expect(events.find((e) => e.kind === 'remote-pair')).toEqual({ kind: 'remote-pair', result: 'expired' });
    const r = await fetch(`${s.url}/remote`);
    expect(r.status).toBe(200);
  });

  it('a closed window lets go of the keeper; a window without one sends no state and answers /remote 503', async () => {
    const keeper = new RemoteKeeper({ pollMs: 3_600_000 });
    const s = await boot(keeper);
    await s.close();
    expect(keeper.listenerCount('state')).toBe(0);
    const bare = await boot();
    const events = await connect(bare.url);
    await until(() => events.some((e) => e.kind === 'hello'));
    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.kind === 'remote')).toBe(false);
    expect((await fetch(`${bare.url}/remote`)).status).toBe(503);
  });
});
