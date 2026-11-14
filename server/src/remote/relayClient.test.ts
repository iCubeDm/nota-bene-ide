import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { generateKeyPair, publicOf, type KeyPair } from './noise.ts';
import { relayProof, RelayClient } from './relayClient.ts';
import { b64u, deviceHash, fromB64u, hostId } from './store.ts';
import { inviteMember, startRelay, type TestRelay } from './testRelay.ts';
import { parseAccessKey } from './store.ts';

const seq = (from: number) => Buffer.from(Array.from({ length: 32 }, (_, i) => from + i));
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A bare device: admission only, then raw frames. */
function device(url: string, host: Buffer, key: KeyPair, ticket?: Buffer) {
  const ws = new WebSocket(`${url}/v1/device?host=${hostId(host)}`);
  const got: Buffer[] = [];
  const state: { conn?: number; closed?: number } = {};
  ws.on('message', (data, binary) => {
    if (binary) return void got.push(data as Buffer);
    const m = JSON.parse(String(data)) as { t: string; eph?: string; nonce?: string; conn?: number };
    if (m.t === 'challenge') {
      const proof = relayProof('device', key.priv, fromB64u(m.eph!, 32), fromB64u(m.nonce!, 32));
      ws.send(JSON.stringify({ t: 'hello', key: b64u(key.pub), proof: b64u(proof), ...(ticket ? { ticket: b64u(ticket) } : {}) }));
    } else if (m.t === 'ok') state.conn = m.conn;
  });
  ws.on('close', (code) => (state.closed = code));
  ws.on('error', () => {});
  return { ws, got, state };
}

function host(url: string, key: KeyPair, list: string[] = [], ticket: Buffer | null = null, member: () => Buffer | null = () => null) {
  const c = new RelayClient({ url, key, devices: () => list, ticket: () => ticket, member, backoff: { minMs: 50, maxMs: 200 } });
  const ev = { online: 0, offline: [] as number[], opens: [] as [number, string][], gone: [] as number[], frames: [] as [number, Buffer][], fatal: [] as string[], limited: 0 };
  c.on('limited', () => ev.limited++);
  c.on('online', () => ev.online++);
  c.on('offline', (code: number) => ev.offline.push(code));
  c.on('open', (conn: number, dev: string) => ev.opens.push([conn, dev]));
  c.on('gone', (conn: number) => ev.gone.push(conn));
  c.on('frame', (conn: number, p: Buffer) => ev.frames.push([conn, p]));
  c.on('fatal', (_code: number, msg: string) => ev.fatal.push(msg));
  c.start();
  return { c, ev, setList: (l: string[]) => { list = l; c.setDevices(l); }, setTicket: (t: Buffer | null) => { ticket = t; c.setTicket(t); } };
}

let relay: TestRelay;
beforeAll(async () => {
  relay = await startRelay();
}, 120_000);
afterAll(async () => {
  await relay?.stop();
});

describe('relay client', () => {
  it('reproduces the proofs of the protocol example', () => {
    const eph = fromB64u('ZLEBsdC-WocEvQePmJUAH8A-jp-VIvGI3RKNmEbUhGY', 32);
    const nonce = seq(0x61);
    expect(b64u(relayProof('device', seq(0x01), eph, nonce))).toBe('X2BJlpgFEN2Z9t7I2JL_d3lZgo0FRsi2nCTG5pOa6II');
    expect(b64u(relayProof('host', seq(0x21), eph, nonce))).toBe('n7FU6_HfPhaPqmnxzofDb73cYRnRzvWyX6abvpdp3wQ');
    expect(b64u(publicOf(seq(0x21)))).toBe('WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns');
  });

  it('admits a listed device and routes frames both ways', async () => {
    const hk = generateKeyPair(), dk = generateKeyPair();
    const h = host(relay.url, hk, [deviceHash(dk.pub)]);
    await until(() => h.ev.online === 1);
    const d = device(relay.url, hk.pub, dk);
    await until(() => h.ev.opens.length === 1);
    const [conn, dev] = h.ev.opens[0]!;
    expect(dev).toBe(deviceHash(dk.pub));
    d.ws.send(Buffer.from('up'));
    await until(() => h.ev.frames.length === 1);
    expect(h.ev.frames[0]).toEqual([conn, Buffer.from('up')]);
    h.c.send(conn, Buffer.from('down'));
    await until(() => d.got.length === 1);
    expect(d.got[0]!.toString()).toBe('down');
    await h.c.stop();
  });

  it('a ticket admits an unlisted device until it is withdrawn', async () => {
    const hk = generateKeyPair(), dk = generateKeyPair(), t = seq(0x90);
    const h = host(relay.url, hk, [], t);
    await until(() => h.ev.online === 1);
    const d = device(relay.url, hk.pub, dk, t);
    await until(() => d.state.conn !== undefined);
    h.setTicket(null);
    h.setList([]);
    await until(() => d.state.closed !== undefined);
    expect(d.state.closed).toBe(4403);
    await h.c.stop();
  });

  it('closeConn cuts a device', async () => {
    const hk = generateKeyPair(), dk = generateKeyPair();
    const h = host(relay.url, hk, [deviceHash(dk.pub)]);
    await until(() => h.ev.online === 1);
    const d = device(relay.url, hk.pub, dk);
    await until(() => h.ev.opens.length === 1);
    h.c.closeConn(h.ev.opens[0]![0]);
    await until(() => d.state.closed !== undefined && h.ev.gone.length === 1);
    expect(d.state.closed).toBe(4403);
    await h.c.stop();
  });

  it('reconnects after the relay restarts and sends its device list again', async () => {
    const hk = generateKeyPair(), dk = generateKeyPair();
    const h = host(relay.url, hk, [deviceHash(dk.pub)]);
    await until(() => h.ev.online === 1);
    const d1 = device(relay.url, hk.pub, dk);
    await until(() => h.ev.opens.length === 1);
    await relay.restart();
    await until(() => h.ev.offline.length === 1 && h.ev.gone.length === 1);
    await until(() => h.ev.online === 2);
    expect(d1.state.closed).toBeDefined();
    device(relay.url, hk.pub, dk);
    await until(() => h.ev.opens.length === 2);
    await h.c.stop();
  }, 20_000);

  it('a second host with the same key stops the first for good', async () => {
    const hk = generateKeyPair();
    const a = host(relay.url, hk);
    await until(() => a.ev.online === 1);
    const b = host(relay.url, hk);
    await until(() => a.ev.fatal.length === 1);
    expect(a.ev.fatal[0]).toMatch(/another nota-bene remote with this host key/);
    await new Promise((r) => setTimeout(r, 600));
    expect(a.ev.online).toBe(1);
    await b.c.stop();
    await a.c.stop();
  });

  it('a relay that goes silent (a laptop that slept through the close) is dropped and reconnected', async () => {
    let conns = 0;
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => {
      conns++;
      ws.send(JSON.stringify({ t: 'challenge', eph: b64u(generateKeyPair().pub), nonce: b64u(seq(0x61)) }));
      ws.once('message', () => ws.send(JSON.stringify({ t: 'ok' }))); // and then nothing: no pings, no close
    });
    const port = (wss.address() as { port: number }).port;
    const c = new RelayClient({ url: `ws://127.0.0.1:${port}`, key: generateKeyPair(), devices: () => [], ticket: () => null, backoff: { minMs: 20, maxMs: 50 }, silenceMs: 300 });
    let online = 0;
    c.on('online', () => online++);
    c.start();
    await until(() => online >= 2 && conns >= 2, 5000);
    await c.stop();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
  });
});

describe('relay client with access keys', () => {
  let keyed: TestRelay;
  let dir: string;
  let alice: Buffer, bob: Buffer;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-members-'));
    const file = path.join(dir, 'members.json');
    alice = parseAccessKey(await inviteMember(file, 'alice', 1));
    bob = parseAccessKey(await inviteMember(file, 'bob', 1));
    keyed = await startRelay({ members: file });
  }, 120_000);
  afterAll(async () => {
    await keyed?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a keyed relay admits a signed hello and refuses an unsigned one for good, saying why', async () => {
    const signed = host(keyed.url, generateKeyPair(), [], null, () => alice);
    await until(() => signed.ev.online === 1);
    const bare = host(keyed.url, generateKeyPair());
    await until(() => bare.ev.fatal.length === 1);
    expect(bare.ev.fatal[0]).toMatch(/no access key, or one it does not know or revoked/);
    await signed.c.stop();
  });

  it('over the key\'s limit: 4405 is retried, and the host gets in once a slot is free', async () => {
    const first = host(keyed.url, generateKeyPair(), [], null, () => alice);
    await until(() => first.ev.online === 1);
    const second = host(keyed.url, generateKeyPair(), [], null, () => alice);
    await until(() => second.ev.limited >= 2);
    expect(second.ev.fatal).toEqual([]);
    await first.c.stop();
    await until(() => second.ev.online === 1);
    await second.c.stop();
  });

  it('reconnect connects now with the key it reads then', async () => {
    let key: Buffer | null = alice;
    const blocker = host(keyed.url, generateKeyPair(), [], null, () => alice);
    await until(() => blocker.ev.online === 1);
    const h = new RelayClient({ url: keyed.url, key: generateKeyPair(), devices: () => [], ticket: () => null, member: () => key, backoff: { minMs: 5000, maxMs: 5000 } });
    let limited = 0, online = 0;
    h.on('limited', () => limited++);
    h.on('online', () => online++);
    h.start();
    await until(() => limited === 1);
    key = bob;
    h.reconnect(); // without it the next try is 5 s away
    await until(() => online === 1, 2000);
    await h.stop();
    await blocker.c.stop();
  });
});
