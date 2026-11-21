// `nota-bene remote`: one per host user. As a host (while a relay is saved and access is on) it keeps the relay
// connection, a DeviceChannel per device connection and the pairing in flight; devices.json is the source of truth for
// who may connect, and the relay's filter is updated from it live. As a device of other computers (issue 297) it keeps a
// HostLink per computer in hosts.json. And the control socket.
//
// Pairing: one code at a time (a new `pair` cancels the previous one). While a code is valid the relay holds its
// ticket, so any phone presenting it reaches the host; the first valid proof is paired, and every later one is refused
// in the handshake and announced. The code ends at expiry, when its `pair` client goes before it is used, or with a new
// `pair`.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type net from 'node:net';
import { PROTOCOL, type HostWindow } from '@nota-bene/shared';
import { DeviceChannel } from './device.ts';
import { Windows } from './discover.ts';
import { closeControl, running, serveControl, write, type Msg } from './control.ts';
import { HostLink } from './hostLink.ts';
import type { KeyPair } from './noise.ts';
import { WindowProxy, type EnterTarget } from './proxy.ts';
import { readPrefs } from '../prefs.ts';
import { bareRow, enterUrl, listProjects, PROVIDERS, remoteRows, type Computer } from '../projects.ts';
import type { AgentProvider } from '../agent/provider.ts';
import { KEY_LIMIT, KEY_LIMIT_MESSAGE, RelayClient } from './relayClient.ts';
import {
  addDevice, b64u, clearLastError, deviceHash, deviceKey, fingerprint, fromB64u, hostKey, pairTicket, pairUri, readAccessKey, readDevices, readHosts, readLastError,
  removeDevice, renameHost, writeLastError, type Device, type Host,
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
  /** the relay this computer is a host on; none: it only connects to other computers */
  #relayUrl: string | undefined;
  #ttl: number;
  #backoff: { minMs: number; maxMs: number } | undefined;
  #key!: KeyPair;
  #relay: RelayClient | undefined;
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
  #links = new Map<string, { link: HostLink; host: Host }>();
  /** the desktop proxies of the paired computers' windows (proxy.ts): each keeps this connector up */
  #proxies = new Set<WindowProxy>();
  #lingerMs: number | undefined;

  /** `managed`: started by a window (`--managed`), so it exits with no window to serve. `version`: the package's, for `status`. */
  constructor(o: {
    relay?: string; windows?: Windows; pairTtlMs?: number; backoff?: { minMs: number; maxMs: number };
    managed?: boolean; version?: string; idleExitMs?: number; lingerMs?: number;
  }) {
    super();
    this.#relayUrl = o.relay;
    this.#managed = o.managed ?? false;
    this.#version = o.version;
    this.#idleMs = o.idleExitMs ?? IDLE_EXIT_MS;
    this.windows = o.windows ?? new Windows();
    this.#ttl = o.pairTtlMs ?? 5 * 60_000;
    this.#backoff = o.backoff;
    this.#lingerMs = o.lingerMs;
  }

  get online(): boolean {
    return this.#relay?.online ?? false;
  }

  /** null when this computer is no host (no relay, or access off) */
  get hostFingerprint(): string | null {
    return this.#relayUrl ? fingerprint(this.#key.pub) : null;
  }

  async start(): Promise<void> {
    if (await running()) throw new Error('nota-bene remote is already running');
    this.windows.on('warn', (m: string) => this.#log(m));
    await this.windows.start();
    // a broken key file or hosts.json refuses the start before anything listens
    if (this.#relayUrl) this.#key = hostKey();
    this.#syncHosts();
    this.#server = await serveControl((m, sock) => this.#control(m, sock));
    if (this.#managed) {
      this.#idleTimer = setInterval(() => this.#idleCheck(), Math.max(10, this.#idleMs / 4));
      this.#idleTimer.unref();
      this.windows.on('change', () => this.#idleCheck());
      this.#idleCheck();
    }
    if (this.#relayUrl) this.#startHost(this.#relayUrl);
  }

  #startHost(url: string): void {
    const relay = (this.#relay = new RelayClient({
      url,
      key: this.#key,
      devices: () => this.#hashes(),
      ticket: () => (this.#pairing ? pairTicket(this.#pairing.secret) : null),
      member: () => this.#accessKey(),
      ...(this.#backoff ? { backoff: this.#backoff } : {}),
    }));
    relay.on('online', () => {
      clearLastError();
      this.#log('online');
      this.emit('online');
    });
    relay.on('offline', (code: number) => {
      this.#log(`offline (relay closed with ${code}); reconnecting`);
      this.emit('offline', code);
    });
    relay.on('limited', () => {
      // the windows say why while it retries; going online clears it
      writeLastError({ code: KEY_LIMIT, message: KEY_LIMIT_MESSAGE, at: Date.now() });
      this.#log(`${KEY_LIMIT_MESSAGE}; retrying`);
    });
    // the key limit is no longer why it is offline (the relay is down, say): the windows stop saying so
    relay.on('retry', () => { if (readLastError()?.code === KEY_LIMIT) clearLastError(); });
    relay.on('fatal', (code: number, message: string) => {
      writeLastError({ code, message, at: Date.now() }); // the windows say why, and wait before they start another
      this.#log(message);
      this.emit('fatal', message);
    });
    relay.on('open', (conn: number, hash: string) => this.#open(conn, hash));
    relay.on('frame', (conn: number, payload: Buffer) => this.#channels.get(conn)?.ch.receive(payload));
    relay.on('gone', (conn: number) => {
      this.#channels.get(conn)?.ch.close();
      this.#channels.delete(conn);
    });
    relay.start();
  }

  /**
   * Brings the links in line with hosts.json: a forgotten computer's link stops, a new one starts, and one whose relay
   * changed or that gave up (revoked, paired again since) starts over.
   */
  #syncHosts(): void {
    const hosts = readHosts();
    for (const [id, l] of [...this.#links]) {
      const h = hosts.find((x) => x.id === id);
      if (h && h.pub === l.host.pub && h.relay === l.host.relay && !l.link.done) {
        l.host = h;
        continue;
      }
      l.link.stop();
      this.#links.delete(id);
    }
    // a managed connector with no host side and no computer left (the last one forgotten) has nothing to do
    if (hosts.length === 0 && this.#managed && !this.#relayUrl && this.#server) {
      this.#log('no relay and no paired computer; exiting');
      setImmediate(() => this.emit('exit', 'idle'));
    }
    if (hosts.length === 0) return;
    const key = deviceKey();
    for (const h of hosts) {
      if (this.#links.has(h.id)) continue;
      const link = new HostLink({ relay: h.relay, hostPub: fromB64u(h.pub, 32), key, ...(this.#backoff ? { backoff: this.#backoff } : {}) });
      const entry = { link, host: h };
      link.on('state', (st: string) => this.#log(`computer ${h.id}: ${st}`));
      // what it calls itself now (renamed, or paired before it said): saved, unless it was forgotten meanwhile
      link.on('name', (name: string) => {
        if (this.#links.get(h.id) !== entry || entry.host.name === name) return;
        try {
          entry.host = renameHost(fromB64u(h.pub, 32), name) ?? entry.host;
        } catch (e) {
          this.#log(`computer ${h.id}: its name was not saved: ${(e as Error).message}`);
        }
      });
      this.#links.set(h.id, entry);
      link.start();
    }
  }

  /** The latest `windows` list of a paired computer (empty while its link is down). */
  hostWindows(id: string): HostWindow[] {
    return this.#links.get(id)?.link.windows ?? [];
  }

  /** The paired computers whose channel is up, with their windows (issue 297: A's switcher lists them). */
  computers(): Computer[] {
    return [...this.#links.values()].filter((l) => l.link.state === 'online')
      .map((l) => ({ id: l.host.id, name: l.host.name ?? fingerprint(fromB64u(l.host.pub, 32)), windows: l.link.windows }));
  }

  /** A desktop proxy for that window of a paired computer (proxy.ts): its login URL, or why not. */
  async openProxy(host: string, port: number): Promise<{ url: string } | { error: string }> {
    const l = this.#links.get(host);
    if (!l || l.link.state !== 'online') return { error: 'not connected' };
    if (!l.link.windows.some((w) => w.port === port)) return { error: 'no such window' };
    const computer = { host, name: l.host.name ?? fingerprint(fromB64u(l.host.pub, 32)) };
    const p: WindowProxy = new WindowProxy({
      lang: () => { try { return readPrefs().lang; } catch { return undefined; } },
      // the computer's link of the moment (one paired again, or on a new relay, has a new one)
      open: (o) => this.#links.get(host)?.link.open(o) ?? null, port, computer,
      projects: async () => {
        // this computer's windows (none current: the page is the other one's) and the paired ones'; no Recent, which
        // would open folders here. Only that computer's own rows say more than what lists and moves
        const own = await listProjects({ port: 0, provider: 'claude' });
        const rows = remoteRows(this.computers(), { host, port });
        return { running: [...own.running.map(bareRow), ...rows.map((r) => (r.remote?.host === host ? r : bareRow(r)))], recent: [], hidden: [] };
      },
      enter: (to) => this.#enter(to),
      onClose: () => {
        this.#proxies.delete(p);
        if (this.#server) this.#idleCheck();
      },
      ...(this.#lingerMs !== undefined ? { lingerMs: this.#lingerMs } : {}),
    });
    await p.start();
    this.#proxies.add(p);
    this.#log(`computer ${host}: window ${port} on localhost:${p.port}`);
    return { url: p.url };
  }

  async #enter(to: EnterTarget): Promise<{ url: string } | { error: string }> {
    if ('host' in to) return this.openProxy(to.host, to.port);
    if (!(PROVIDERS as string[]).includes(to.provider)) return { error: 'no such window' };
    return enterUrl({ provider: to.provider as AgentProvider, port: to.port, root: to.root });
  }

  #hostView(h: Host): Msg {
    return {
      id: h.id, ...(h.name ? { name: h.name } : {}), fingerprint: fingerprint(fromB64u(h.pub, 32)),
      state: this.#links.get(h.id)?.link.state ?? 'connecting', pairedAt: h.addedAt,
    };
  }

  #idleCheck(): void {
    if (!this.#managed) return;
    if (this.windows.list().length > 0 || this.#proxies.size > 0) return void (this.#idleSince = undefined);
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
    for (const { link } of this.#links.values()) link.stop();
    this.#links.clear();
    if (this.#server) {
      const srv = this.#server;
      this.#server = undefined;
      await closeControl(srv);
    }
    for (const p of [...this.#proxies]) p.close();
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
      send: (b) => this.#relay!.send(conn, b),
      drop: () => {
        this.#channels.delete(conn);
        this.#relay!.closeConn(conn);
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
    this.#relay!.setDevices(this.#hashes());
    this.#log(`paired ${d.name ?? 'a phone'} (id ${d.id}, fingerprint ${fingerprint(pub)})`);
    if (p.client) write(p.client, { t: 'paired', device: { ...this.#view(d), online: true } });
    return true;
  }

  #endPairing(p: Pairing, notice: 'expired' | 'cancelled' | undefined): void {
    if (this.#pairing !== p) return;
    clearTimeout(p.timer);
    this.#pairing = undefined;
    this.#relay?.setTicket(null);
    if (notice && !p.used && p.client) write(p.client, { t: notice });
  }

  #startPairing(client: net.Socket): Msg {
    if (!this.#relayUrl) return { t: 'error', code: 'noRelay', message: 'this computer is not reachable through a relay: save a relay and turn access on' };
    if (this.#pairing) this.#endPairing(this.#pairing, 'cancelled');
    const secret = randomBytes(32);
    const expiresAt = Date.now() + this.#ttl;
    const p: Pairing = { secret, expiresAt, used: false, client, timer: setTimeout(() => this.#endPairing(p, 'expired'), this.#ttl) };
    this.#pairing = p;
    this.#relay!.setTicket(pairTicket(secret));
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
    this.#relay?.setDevices(this.#hashes());
    for (const [conn, c] of [...this.#channels]) {
      // by the key the phone proved in the handshake, not the relay's label (a channel still in its handshake goes too)
      if (c.ch.devicePub ? b64u(c.ch.devicePub) !== d.pub : c.hash !== deviceHash(fromB64u(d.pub, 32))) continue;
      c.ch.close(); // its frames are ignored from now on, whatever the relay still delivers
      this.#channels.delete(conn);
      this.#relay!.closeConn(conn);
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
    try {
      this.#answer(m, sock);
    } catch (e) {
      // a broken state file (devices.json, hosts.json): said, and the connector goes on
      this.#log((e as Error).message);
      write(sock, { ok: false, error: (e as Error).message });
    }
  }

  #answer(m: Msg, sock: net.Socket): void {
    switch (m.op) {
      case 'status':
        return write(sock, {
          online: this.online, relay: this.#relayUrl ?? null, hostFingerprint: this.hostFingerprint,
          windows: this.windows.list().length, devices: readDevices().map((d) => this.#view(d)), hosts: readHosts().map((h) => this.#hostView(h)),
          ...(this.#version ? { version: this.#version } : {}), protocol: PROTOCOL, managed: this.#managed,
          pairing: this.#pairing && !this.#pairing.used ? { expiresAt: this.#pairing.expiresAt } : null,
        });
      case 'reconnect':
        // a new access key: connect with it now
        write(sock, { ok: true });
        this.#log('reconnecting with the saved access key');
        return void this.#relay?.reconnect();
      case 'stop':
        write(sock, { ok: true });
        this.#log('asked to stop over the control socket');
        return void setImmediate(() => this.emit('exit', 'stop'));
      case 'devices':
        return write(sock, { devices: readDevices().map((d) => this.#view(d)) });
      case 'revoke':
        return write(sock, typeof m.id === 'string' ? this.revoke(m.id) : { ok: false, error: 'revoke needs an id' });
      case 'hosts':
        // hosts.json changed (a computer paired or forgotten, by a window or the CLI)
        this.#syncHosts();
        return write(sock, { hosts: readHosts().map((h) => this.#hostView(h)) });
      case 'computers':
        return write(sock, { computers: this.computers() });
      case 'open':
        if (typeof m.host !== 'string' || !Number.isInteger(m.port)) return write(sock, { error: 'bad request' });
        return void this.openProxy(m.host, m.port as number).then((r) => write(sock, r), (e: Error) => write(sock, { error: e.message }));
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
