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
import type net from 'node:net';
import { DeviceChannel } from './device.ts';
import { Windows } from './discover.ts';
import { closeControl, running, serveControl, write, type Msg } from './control.ts';
import type { KeyPair } from './noise.ts';
import { KEY_LIMIT, KEY_LIMIT_MESSAGE, RelayClient } from './relayClient.ts';
import {
  addDevice, b64u, clearLastError, deviceHash, fingerprint, fromB64u, hostKey, pairTicket, pairUri, readAccessKey, readDevices, readLastError, removeDevice, writeLastError, type Device,
} from './store.ts';

const MAX_DEVICES = 32; // the relay's limit for a device list
/** How long a connector the windows started stays with no window to serve (a window restarting within it keeps the phone). */
export const IDLE_EXIT_MS = 60_000;

type Pairing = { secret: Buffer; expiresAt: number; used: boolean; client: net.Socket | undefined; timer: NodeJS.Timeout };

/**
 * Events: `log(message)` (never content), `online`, `offline(code)`, `fatal(message)`, `exit(reason)`: the connector asks
 * its runner to stop, `stop` (a window turned access off or replaced it) or `idle` (a managed one with no window left).
 */
export class Connector extends EventEmitter {
  readonly windows: Windows;
  #relayUrl: string;
  #ttl: number;
  #backoff: { minMs: number; maxMs: number } | undefined;
  #key!: KeyPair;
  #relay!: RelayClient;
  #keyWarned = false;
  #server: net.Server | undefined;
  #channels = new Map<number, { ch: DeviceChannel; hash: string }>();
  #pairing: Pairing | undefined;
  #pairClients = new Set<net.Socket>();
  #managed: boolean;
  #version: string | undefined;
  #idleMs: number;
  #idleSince: number | undefined;
  #idleTimer: NodeJS.Timeout | undefined;

  /** `managed`: started by a window (`--managed`), so it exits with no window to serve. `version`: the package's, for `status`. */
  constructor(o: {
    relay: string; windows?: Windows; pairTtlMs?: number; backoff?: { minMs: number; maxMs: number };
    managed?: boolean; version?: string; idleExitMs?: number;
  }) {
    super();
    this.#relayUrl = o.relay;
    this.#managed = o.managed ?? false;
    this.#version = o.version;
    this.#idleMs = o.idleExitMs ?? IDLE_EXIT_MS;
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
      member: () => this.#accessKey(),
      ...(this.#backoff ? { backoff: this.#backoff } : {}),
    });
    this.#relay.on('online', () => {
      clearLastError();
      this.#log('online');
      this.emit('online');
    });
    this.#relay.on('offline', (code: number) => {
      this.#log(`offline (relay closed with ${code}); reconnecting`);
      this.emit('offline', code);
    });
    this.#relay.on('limited', () => {
      // the windows say why while it retries; going online clears it
      writeLastError({ code: KEY_LIMIT, message: KEY_LIMIT_MESSAGE, at: Date.now() });
      this.#log(`${KEY_LIMIT_MESSAGE}; retrying`);
    });
    // the key limit is no longer why it is offline (the relay is down, say): the windows stop saying so
    this.#relay.on('retry', () => { if (readLastError()?.code === KEY_LIMIT) clearLastError(); });
    this.#relay.on('fatal', (code: number, message: string) => {
      writeLastError({ code, message, at: Date.now() }); // the windows say why, and wait before they start another
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
    if (this.#managed) {
      this.#idleTimer = setInterval(() => this.#idleCheck(), Math.max(10, this.#idleMs / 4));
      this.#idleTimer.unref();
      this.windows.on('change', () => this.#idleCheck());
      this.#idleCheck();
    }
  }

  #idleCheck(): void {
    if (this.windows.list().length > 0) return void (this.#idleSince = undefined);
    const now = Date.now();
    this.#idleSince ??= now;
    if (now - this.#idleSince < this.#idleMs) return;
    clearInterval(this.#idleTimer);
    this.#log(`no window for ${Math.round(this.#idleMs / 1000)} s; exiting`);
    this.emit('exit', 'idle');
  }

  async stop(): Promise<void> {
    clearInterval(this.#idleTimer);
    if (this.#pairing) clearTimeout(this.#pairing.timer);
    this.#pairing = undefined;
    for (const { ch } of this.#channels.values()) ch.close();
    this.#channels.clear();
    for (const s of this.#pairClients) s.destroy();
    if (this.#server) {
      const srv = this.#server;
      this.#server = undefined;
      await closeControl(srv);
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
    const online = [...this.#channels.values()].some((c) => c.ch.devicePub !== undefined && b64u(c.ch.devicePub) === d.pub);
    return { id: d.id, ...(d.name ? { name: d.name } : {}), fingerprint: fingerprint(fromB64u(d.pub, 32)), online, pairedAt: d.addedAt };
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
      deviceHash: hash,
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
    this.#relay.setDevices(this.#hashes());
    for (const [conn, c] of [...this.#channels]) {
      // by the key the phone proved in the handshake, not the relay's label (a channel still in its handshake goes too)
      if (c.ch.devicePub ? b64u(c.ch.devicePub) !== d.pub : c.hash !== deviceHash(fromB64u(d.pub, 32))) continue;
      c.ch.close(); // its frames are ignored from now on, whatever the relay still delivers
      this.#channels.delete(conn);
      this.#relay.closeConn(conn);
    }
    this.#log(`revoked ${d.id}`);
    return { ok: true, device: { ...this.#view(d), online: false } };
  }

  /** The saved access key, read for every relay connection; a broken file is reported once and the hello goes unsigned. */
  #accessKey(): Buffer | null {
    try {
      const k = readAccessKey();
      this.#keyWarned = false;
      return k;
    } catch (e) {
      if (!this.#keyWarned) this.#log((e as Error).message);
      this.#keyWarned = true;
      return null;
    }
  }

  #control(m: Msg, sock: net.Socket): void {
    switch (m.op) {
      case 'status':
        return write(sock, {
          online: this.online, relay: this.#relayUrl, hostFingerprint: this.hostFingerprint,
          windows: this.windows.list().length, devices: readDevices().map((d) => this.#view(d)),
          ...(this.#version ? { version: this.#version } : {}), managed: this.#managed,
          pairing: this.#pairing && !this.#pairing.used ? { expiresAt: this.#pairing.expiresAt } : null,
        });
      case 'reconnect':
        // a new access key: connect with it now
        write(sock, { ok: true });
        this.#log('reconnecting with the saved access key');
        return void this.#relay.reconnect();
      case 'stop':
        write(sock, { ok: true });
        this.#log('asked to stop over the control socket');
        return void setImmediate(() => this.emit('exit', 'stop'));
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
