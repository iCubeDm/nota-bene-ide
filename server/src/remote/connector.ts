// `nota-bene remote`: one per host user. It keeps the relay connection, a DeviceChannel per phone connection, the
// pairing in flight and the control socket. devices.json is the source of truth for who may connect; the relay's
// filter is updated from it live.
//
// Pairing: one code at a time (a new `pair` cancels the previous one). While a code is valid the relay holds its
// ticket, so any phone presenting it reaches the host; the first valid proof is paired, and every later one is refused
// in the handshake and announced. The code ends at expiry, when its `pair` client goes before it is used, or with a new
// `pair`.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type net from 'node:net';
import { DeviceChannel } from './device.ts';
import { Windows } from './discover.ts';
import { running, serveControl, socketPath, write, type Msg } from './control.ts';
import type { KeyPair } from './noise.ts';
import { RelayClient } from './relayClient.ts';
import {
  addDevice, b64u, deviceHash, fingerprint, fromB64u, hostKey, pairTicket, pairUri, readDevices, removeDevice, type Device,
} from './store.ts';

const MAX_DEVICES = 32; // the relay's limit for a device list

type Pairing = { secret: Buffer; expiresAt: number; used: boolean; client: net.Socket | undefined; timer: NodeJS.Timeout };

/** Events: `log(message)` (never content), `online`, `offline(code)`, `fatal(message)`. */
export class Connector extends EventEmitter {
  readonly windows: Windows;
  #relayUrl: string;
  #ttl: number;
  #backoff: { minMs: number; maxMs: number } | undefined;
  #key!: KeyPair;
  #relay!: RelayClient;
  #server: net.Server | undefined;
  #channels = new Map<number, { ch: DeviceChannel; hash: string }>();
  #pairing: Pairing | undefined;
  #pairClients = new Set<net.Socket>();

  constructor(o: { relay: string; windows?: Windows; pairTtlMs?: number; backoff?: { minMs: number; maxMs: number } }) {
    super();
    this.#relayUrl = o.relay;
    this.windows = o.windows ?? new Windows();
    this.#ttl = o.pairTtlMs ?? 5 * 60_000;
    this.#backoff = o.backoff;
  }

  get online(): boolean {
    return this.#relay?.online ?? false;
  }

  get hostFingerprint(): string {
    return fingerprint(this.#key.pub);
  }

  async start(): Promise<void> {
    if (await running()) throw new Error('nota-bene remote is already running');
    this.#key = hostKey();
    this.windows.on('warn', (m: string) => this.#log(m));
    await this.windows.start();
    this.#relay = new RelayClient({
      url: this.#relayUrl,
      key: this.#key,
      devices: () => this.#hashes(),
      ticket: () => (this.#pairing ? pairTicket(this.#pairing.secret) : null),
      ...(this.#backoff ? { backoff: this.#backoff } : {}),
    });
    this.#relay.on('online', () => {
      this.#log('online');
      this.emit('online');
    });
    this.#relay.on('offline', (code: number) => {
      this.#log(`offline (relay closed with ${code}); reconnecting`);
      this.emit('offline', code);
    });
    this.#relay.on('fatal', (_code: number, message: string) => {
      this.#log(message);
      this.emit('fatal', message);
    });
    this.#relay.on('open', (conn: number, hash: string) => this.#open(conn, hash));
    this.#relay.on('frame', (conn: number, payload: Buffer) => this.#channels.get(conn)?.ch.receive(payload));
    this.#relay.on('gone', (conn: number) => {
      this.#channels.get(conn)?.ch.close();
      this.#channels.delete(conn);
    });
    this.#server = await serveControl((m, sock) => this.#control(m, sock));
    this.#relay.start();
  }

  async stop(): Promise<void> {
    if (this.#pairing) clearTimeout(this.#pairing.timer);
    this.#pairing = undefined;
    for (const { ch } of this.#channels.values()) ch.close();
    this.#channels.clear();
    for (const s of this.#pairClients) s.destroy();
    if (this.#server) {
      const srv = this.#server;
      this.#server = undefined;
      await new Promise((r) => srv.close(r));
      fs.rmSync(socketPath(), { force: true });
    }
    this.windows.stop();
    await this.#relay?.stop();
  }

  #log(m: string): void {
    this.emit('log', m);
  }

  #hashes(): string[] {
    return readDevices().slice(0, MAX_DEVICES).map((d) => deviceHash(fromB64u(d.pub, 32)));
  }

  #view(d: Device): Msg {
    const hash = deviceHash(fromB64u(d.pub, 32));
    const online = [...this.#channels.values()].some((c) => c.hash === hash && c.ch.devicePub !== undefined);
    return { id: d.id, ...(d.name ? { name: d.name } : {}), fingerprint: fingerprint(fromB64u(d.pub, 32)), online };
  }

  #open(conn: number, hash: string): void {
    const ch = new DeviceChannel({
      hostKey: this.#key,
      send: (b) => this.#relay.send(conn, b),
      drop: () => {
        this.#channels.delete(conn);
        this.#relay.closeConn(conn);
      },
      windows: this.windows,
      pairing: () => this.#pairing ?? null,
      onPaired: (pub, name) => this.#paired(pub, name),
      isListed: (pub) => readDevices().some((d) => d.pub === b64u(pub)),
    });
    this.#channels.set(conn, { ch, hash });
  }

  #paired(pub: Buffer, name?: string): boolean {
    const p = this.#pairing;
    if (!p) return false;
    if (p.used) {
      const fp = fingerprint(pub);
      this.#log(`refused a second phone presenting the pairing code that was already used (fingerprint ${fp})`);
      for (const s of this.#pairClients) write(s, { t: 'refused', fingerprint: fp });
      return false;
    }
    if (readDevices().length >= MAX_DEVICES) {
      this.#log(`refused pairing: ${MAX_DEVICES} phones are paired already; revoke one first`);
      if (p.client) write(p.client, { t: 'error', message: `${MAX_DEVICES} phones are paired already; revoke one first` });
      return false;
    }
    p.used = true;
    const d = addDevice(pub, name);
    this.#relay.setDevices(this.#hashes());
    this.#log(`paired ${d.name ?? 'a phone'} (id ${d.id}, fingerprint ${fingerprint(pub)})`);
    if (p.client) write(p.client, { t: 'paired', device: { ...this.#view(d), online: true } });
    return true;
  }

  #endPairing(p: Pairing, notice: 'expired' | 'cancelled' | undefined): void {
    if (this.#pairing !== p) return;
    clearTimeout(p.timer);
    this.#pairing = undefined;
    this.#relay.setTicket(null);
    if (notice && !p.used && p.client) write(p.client, { t: notice });
  }

  #startPairing(client: net.Socket): Msg {
    if (this.#pairing) this.#endPairing(this.#pairing, 'cancelled');
    const secret = randomBytes(32);
    const expiresAt = Date.now() + this.#ttl;
    const p: Pairing = { secret, expiresAt, used: false, client, timer: setTimeout(() => this.#endPairing(p, 'expired'), this.#ttl) };
    this.#pairing = p;
    this.#relay.setTicket(pairTicket(secret));
    return { t: 'code', uri: pairUri({ relay: this.#relayUrl, hostPub: this.#key.pub, secret }), hostFingerprint: this.hostFingerprint, expiresAt };
  }

  revoke(id: string): Msg {
    let d: Device | null;
    try {
      d = removeDevice(id);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (!d) return { ok: false, error: `no paired device ${id}` };
    const hash = deviceHash(fromB64u(d.pub, 32));
    this.#relay.setDevices(this.#hashes());
    for (const [conn, c] of [...this.#channels]) {
      if (c.hash !== hash) continue;
      c.ch.close(); // its frames are ignored from now on, whatever the relay still delivers
      this.#channels.delete(conn);
      this.#relay.closeConn(conn);
    }
    this.#log(`revoked ${d.id}`);
    return { ok: true, device: { ...this.#view(d), online: false } };
  }

  #control(m: Msg, sock: net.Socket): void {
    switch (m.op) {
      case 'status':
        return write(sock, {
          online: this.online, relay: this.#relayUrl, hostFingerprint: this.hostFingerprint,
          windows: this.windows.list().length, devices: readDevices().map((d) => this.#view(d)),
        });
      case 'devices':
        return write(sock, { devices: readDevices().map((d) => this.#view(d)) });
      case 'revoke':
        return write(sock, typeof m.id === 'string' ? this.revoke(m.id) : { ok: false, error: 'revoke needs an id' });
      case 'pair': {
        this.#pairClients.add(sock);
        sock.once('close', () => {
          this.#pairClients.delete(sock);
          const p = this.#pairing;
          if (p?.client === sock && !p.used) this.#endPairing(p, undefined);
        });
        return write(sock, this.#startPairing(sock));
      }
      default:
        return write(sock, { ok: false, error: 'unknown op' });
    }
  }
}
