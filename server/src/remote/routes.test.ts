import http, { type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RemoteState } from '@nota-bene/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { EventHub } from '../hub.ts';
import { LegacyConnector, NotRunning } from './keeper.ts';
import { remoteRoutes, type RemoteKeeperApi } from './routes.ts';

let server: http.Server | undefined;
afterEach(async () => {
  await new Promise<void>((done) => { if (server) server.close(() => done()); else done(); });
  server = undefined;
});

const STATE: RemoteState = {
  configured: true, enabled: true, running: true, online: true, relay: 'wss://relay.example.com', hostFingerprint: 'abcd-efgh-ijkl-mnop',
  devices: [{ id: 'abcd', name: 'Test phone', fingerprint: 'qrst-uvwx-yz23-4567', online: true, pairedAt: 1 }],
  pairing: null, legacy: false, lastError: null, startFailed: false,
};

function fake(over: Partial<RemoteKeeperApi> = {}) {
  const calls: unknown[] = [];
  const k: RemoteKeeperApi = {
    refresh: async () => STATE,
    setConfig: async (c) => { calls.push(c); return { state: STATE, stopped: null }; },
    pair: async () => ({ uri: 'nbremote://pair?v=1', qr: '<svg/>', hostFingerprint: 'abcd-efgh-ijkl-mnop', expiresAt: 5 }),
    cancelPair: () => void calls.push('cancel'),
    revoke: async (id) => { calls.push(id); return { ok: true }; },
    ...over,
  };
  return { k, calls };
}

async function serve(keeper: RemoteKeeperApi | undefined): Promise<string> {
  const routes = remoteRoutes({ hub: new EventHub(), keeper });
  server = http.createServer(((req, res) => routes[req.url!.split('?')[0]!]!(req, res)) as RequestListener);
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const post = (base: string, p: string, body?: unknown) => fetch(base + p, { method: 'POST', body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });

describe('remote routes', () => {
  it('GET /remote is the state; a POST route refuses GET', async () => {
    const base = await serve(fake().k);
    const r = await fetch(`${base}/remote`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(STATE);
    expect((await fetch(`${base}/remote/pair`)).status).toBe(405);
    expect((await post(base, '/remote')).status).toBe(405);
  });

  it('config passes the relay (trimmed) and the switch on, and refuses wrong types', async () => {
    const { k, calls } = fake();
    const base = await serve(k);
    expect((await post(base, '/remote/config', { relay: ' wss://relay.example.com ' })).status).toBe(200);
    expect((await post(base, '/remote/config', { enabled: false })).status).toBe(200);
    expect(calls).toEqual([{ relay: 'wss://relay.example.com' }, { enabled: false }]);
    expect((await post(base, '/remote/config', { enabled: 'yes' })).status).toBe(400);
    expect((await post(base, '/remote/config', { relay: 5 })).status).toBe(400);
    expect((await post(base, '/remote/config', '{')).status).toBe(400);
  });

  it('a bad relay address is a 400 with the reason; a terminal connector of an older version is a 409', async () => {
    const base = await serve(fake({
      setConfig: async (c) => {
        if (c.relay) throw new Error(`the relay must be a wss:// URL (ws:// only on 127.0.0.1 or localhost with a port): ${c.relay}`);
        throw new LegacyConnector();
      },
    }).k);
    const bad = await post(base, '/remote/config', { relay: 'http://relay.example.com' });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toMatch(/wss:\/\//);
    const legacy = await post(base, '/remote/config', { enabled: false });
    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toEqual({ error: 'legacy' });
  });

  it('pair answers the code, or 409 when no connector runs; cancel and revoke reach the keeper', async () => {
    const { k, calls } = fake();
    const base = await serve(k);
    expect(await (await post(base, '/remote/pair')).json()).toMatchObject({ qr: '<svg/>', expiresAt: 5 });
    expect((await post(base, '/remote/pair/cancel')).status).toBe(200);
    expect(await (await post(base, '/remote/revoke', { id: 'abcd' })).json()).toEqual({ ok: true });
    expect((await post(base, '/remote/revoke', {})).status).toBe(400);
    expect(calls).toEqual(['cancel', 'abcd']);
    server!.close();
    const off = await serve(fake({ pair: async () => { throw new NotRunning(); } }).k);
    const r = await post(off, '/remote/pair');
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'not running' });
  });

  it('a window without a keeper answers 503', async () => {
    const base = await serve(undefined);
    expect((await fetch(`${base}/remote`)).status).toBe(503);
  });
});
