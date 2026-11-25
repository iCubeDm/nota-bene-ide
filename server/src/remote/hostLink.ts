// This computer as a device of another one (issue 297). The device end of the channel (CHANNEL.md), as the phone runs it:
// relay admission as a device, the Noise initiator pinning the host's key, the mux as the side that opens streams. On it,
// `pairHost` pairs with a code the other computer shows, and a HostLink per paired computer keeps the channel up with
// its host stream's `windows` list. The connector runs the links (connector.ts); testPhone.ts drives the same end.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { HostStreamMessage, HostWindow, RemoteHostState } from '@nota-bene/shared';
import { cleanName, computerName } from './device.ts';
import { collect, Mux, UNREACHABLE, type Stream } from './mux.ts';
import { CipherState, Handshake, PROLOGUE, type KeyPair } from './noise.ts';
import { relayProof } from './relayClient.ts';
import { addHost, b64u, deviceKey, fromB64u, hostId, pairProof, pairTicket, parsePairUri, Refusal, savedHostKey, type Host } from './store.ts';

/** The device end of one channel: handshake message 1 out, message 2 in, then mux frames both ways. */
export class DeviceEnd {
  readonly key: KeyPair;
  #hs: Handshake;
  #send: (b: Buffer) => void;
  #tx: CipherState | undefined;
  #rx: CipherState | undefined;
  mux: Mux | undefined;
  /** what the host answered in handshake message 2 */
  welcome: unknown;
  ready: Promise<void>;
  #ready!: () => void;
  /** the mux failed (a bad frame, credit exceeded): the connection must go */
  onfail: () => void = () => {};

  constructor(o: { hostPub: Buffer; key: KeyPair; send: (b: Buffer) => void }) {
    this.key = o.key;
    this.#send = o.send;
    this.#hs = Handshake.initiator({ s: this.key, rs: o.hostPub, prologue: PROLOGUE });
    this.ready = new Promise((r) => (this.#ready = r));
  }

  /** Sends handshake message 1 with `payload` (`{v: 1, name?, pair?}`). */
  hello(payload: Record<string, unknown> = { v: 1 }): void {
    this.#send(this.#hs.writeMessage(Buffer.from(JSON.stringify(payload))));
  }

  /** One message from the host; a bad one throws, and the connection must go. */
  receive(b: Buffer): void {
    if (!this.#rx) {
      this.welcome = JSON.parse(this.#hs.readMessage(b).toString('utf8'));
      const { send, recv } = this.#hs.split();
      this.#tx = send;
      this.#rx = recv;
      this.mux = new Mux({ send: (p) => this.#send(this.#tx!.encrypt(p)), onFail: () => this.onfail() });
      this.#ready();
      return;
    }
    this.deliver(this.#rx.decrypt(b));
  }

  /** One decrypted frame to the mux. */
  protected deliver(plain: Buffer): void {
    this.mux!.receive(plain);
  }

  open(o: unknown): Stream {
    return this.mux!.open(o);
  }

  /** Every stream ends (the connection went). */
  close(): void {
    this.mux?.close(UNREACHABLE, 'channel closed');
  }
}

export type DeviceSocket<E extends DeviceEnd> = { end: E; ws: WebSocket; state: { conn?: number; closed?: number }; closed: Promise<number> };

/**
 * A device end through a relay: device admission (a listed key, or the pairing ticket), then `hello` and the channel.
 * With nothing from the relay for `silenceMs` (it pings every 30 s) the connection is presumed dead and dropped.
 */
export function relayDevice<E extends DeviceEnd>(
  o: { url: string; hostPub: Buffer; ticket?: Buffer; hello?: Record<string, unknown>; silenceMs?: number },
  make: (send: (b: Buffer) => void) => E,
): DeviceSocket<E> {
  const ws = new WebSocket(`${o.url.replace(/\/+$/, '')}/v1/device?host=${hostId(o.hostPub)}`, { maxPayload: 1024 * 1024, perMessageDeflate: false });
  const end = make((b) => { if (ws.readyState === WebSocket.OPEN) ws.send(b); });
  end.onfail = () => ws.terminate();
  const state: { conn?: number; closed?: number } = {};
  let quiet: NodeJS.Timeout | undefined;
  const heard = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => ws.terminate(), o.silenceMs ?? 75_000);
  };
  const closed = new Promise<number>((r) => ws.on('close', (code) => {
    clearTimeout(quiet);
    state.closed = code;
    r(code);
  }));
  ws.on('open', heard);
  ws.on('ping', heard);
  ws.on('error', () => { /* the close that follows decides */ });
  ws.on('message', (data: Buffer, binary: boolean) => {
    heard();
    if (binary) {
      try {
        end.receive(data);
      } catch {
        ws.terminate();
      }
      return;
    }
    try {
      const m = JSON.parse(data.toString('utf8')) as { t?: unknown; eph?: unknown; nonce?: unknown; conn?: unknown };
      if (m.t === 'challenge') {
        const proof = relayProof('device', end.key.priv, fromB64u(String(m.eph), 32), fromB64u(String(m.nonce), 32));
        ws.send(JSON.stringify({ t: 'hello', key: b64u(end.key.pub), proof: b64u(proof), ...(o.ticket ? { ticket: b64u(o.ticket) } : {}) }));
      } else if (m.t === 'ok') {
        if (typeof m.conn === 'number') state.conn = m.conn;
        end.hello(o.hello ?? { v: 1 });
      }
    } catch {
      ws.terminate();
    }
  });
  return { end, ws, state, closed };
}

/** What a close before the channel came up means while pairing. */
function pairFailure(code: number): Refusal {
  if (code === 4403) return new Refusal('codeRefused', 'the computer refused the code: it expired, was already used, or was withdrawn');
  if (code === 4404) return new Refusal('hostOffline', 'the computer is not connected to its relay');
  if (code === 4429) return new Refusal('hostFull', 'the computer has too many devices connected');
  return new Refusal('relayUnreachable', `the relay could not be reached (closed with ${code})`, String(code));
}

/**
 * Pairs with the computer whose code this is, as its device, and saves it (`hosts.json`). Message 1 carries this computer's
 * name and the proof of the code; the computer's name comes back in message 2.
 */
export async function pairHost(code: string, o: { timeoutMs?: number; name?: string } = {}): Promise<Host> {
  const p = parsePairUri(code.trim());
  // issue 505: its own code would make this computer its own device
  if (savedHostKey()?.pub.equals(p.hostPub)) throw new Refusal('ownPairCode', 'this is this computer\'s own pairing code: paste it on the other computer');
  const key = deviceKey();
  const name = o.name ?? computerName();
  const sock = relayDevice(
    { url: p.relay, hostPub: p.hostPub, ticket: pairTicket(p.secret), hello: { v: 1, ...(name ? { name } : {}), pair: b64u(pairProof(p.secret, key.pub)) } },
    (send) => new DeviceEnd({ hostPub: p.hostPub, key, send }),
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const won = await Promise.race([
      sock.end.ready.then(() => 'ready' as const),
      sock.closed,
      new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), o.timeoutMs ?? 15_000))),
    ]);
    if (won === 'timeout') throw new Refusal('hostSilent', 'the computer did not answer');
    if (won !== 'ready') throw pairFailure(won);
    const host = (sock.end.welcome as { host?: unknown } | null)?.host;
    const hostName = typeof host === 'string' ? cleanName(host) : undefined;
    return addHost({ relay: p.relay, pub: p.hostPub, ...(hostName ? { name: hostName } : {}) });
  } finally {
    clearTimeout(timer);
    sock.end.close();
    sock.ws.close(1000);
  }
}

/** Closes after which the relay protocol says not to retry unchanged (4403: the computer revoked this one). */
const FINAL = new Set([4401, 4403, 4409, 4413]);

/**
 * The link to one paired computer: reconnects with backoff (as the connector's relay connection does) and keeps the host
 * stream's latest `windows` list, empty while the channel is down. Events: `state(RemoteHostState)`, `windows(list)`,
 * `name(string)`: what the computer calls itself, on every connection. `connecting` until a channel is up and after it
 * dropped, `failing` after an attempt that did not get one, `revoked` when the computer refused this one (no retry).
 */
const isWindow = (w: Partial<HostWindow> | null): w is HostWindow =>
  typeof w?.port === 'number' && typeof w.provider === 'string' && typeof w.root === 'string';

/**
 * What a host stream message lists, the parse boundary's shape check (CHANNEL.md: every other field is optional). Null
 * for any other message.
 */
export function hostStreamWindows(m: unknown): HostWindow[] | null {
  const h = m as Partial<HostStreamMessage> | null;
  if (h?.t !== 'windows' || !Array.isArray(h.windows)) return null;
  return h.windows.filter(isWindow);
}

export class HostLink extends EventEmitter {
  state: RemoteHostState = 'connecting';
  windows: HostWindow[] = [];
  /** no reconnect is pending: revoked, or a close the protocol says not to retry */
  done = false;
  #o: { relay: string; hostPub: Buffer; key: KeyPair; name: string | undefined; backoff: { minMs: number; maxMs: number } };
  #sock: DeviceSocket<DeviceEnd> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #attempt = 0;
  #onlineAt = 0;
  #stopped = false;

  constructor(o: { relay: string; hostPub: Buffer; key: KeyPair; name?: string; backoff?: { minMs: number; maxMs: number } }) {
    super();
    this.#o = { relay: o.relay, hostPub: o.hostPub, key: o.key, name: o.name ?? computerName(), backoff: o.backoff ?? { minMs: 1000, maxMs: 30_000 } };
  }

  start(): void {
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    const s = this.#sock;
    this.#sock = undefined;
    s?.end.close();
    s?.ws.close(1000);
  }

  /** A stream to the computer (CHANNEL.md, Stream kinds) while the channel is up; null while it is down. */
  open(o: unknown): Stream | null {
    const mux = this.state === 'online' ? this.#sock?.end.mux : undefined;
    return mux ? mux.open(o) : null;
  }

  #set(s: RemoteHostState): void {
    if (s === this.state) return;
    this.state = s;
    this.emit('state', s);
  }

  #connect(): void {
    const { relay, hostPub, key, name } = this.#o;
    const sock = relayDevice({ url: relay, hostPub, hello: { v: 1, ...(name ? { name } : {}) } }, (send) => new DeviceEnd({ hostPub, key, send }));
    this.#sock = sock;
    void sock.end.ready.then(() => {
      if (this.#sock !== sock) return;
      this.#onlineAt = Date.now();
      const host = (sock.end.welcome as { host?: unknown } | null)?.host;
      const hostName = typeof host === 'string' ? cleanName(host) : undefined;
      if (hostName) this.emit('name', hostName);
      this.#set('online');
      collect(sock.end.open({ kind: 'host' }), (data) => {
        if (this.#sock !== sock) return;
        try {
          const windows = hostStreamWindows(JSON.parse(data.toString('utf8')));
          if (!windows) return;
          this.windows = windows;
          this.emit('windows', this.windows);
        } catch { /* not JSON: ignored, as an unknown message */ }
      });
    });
    void sock.closed.then((code) => {
      if (this.#sock !== sock) return;
      this.#sock = undefined;
      sock.end.close();
      const was = this.state === 'online';
      if (this.windows.length) {
        this.windows = [];
        this.emit('windows', this.windows);
      }
      if (this.#stopped) return;
      if (FINAL.has(code)) {
        this.done = true;
        return this.#set(code === 4403 ? 'revoked' : 'failing');
      }
      if (was && Date.now() - this.#onlineAt >= 60_000) this.#attempt = 0;
      this.#set(was ? 'connecting' : 'failing');
      const { minMs, maxMs } = this.#o.backoff;
      this.#timer = setTimeout(() => this.#connect(), Math.min(maxMs, minMs * 2 ** this.#attempt++) * (0.8 + Math.random() * 0.4));
    });
  }
}
