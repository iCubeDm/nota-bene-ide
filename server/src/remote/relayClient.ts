// The host's one connection to the relay (relay/PROTOCOL.md): admission with the host key, the paired devices' hashes
// and the pairing ticket, then conn-prefixed binary frames. Reconnects with backoff, except where the protocol says a
// retry cannot help (4401, 4402, 4413) or must not happen (4409: another connector holds this key).
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { dh, type KeyPair } from './noise.ts';
import { b64u, fromB64u, memberPub, memberSign } from './store.ts';

/** HMAC-SHA256(key = X25519(priv, eph), "nb-relay-v1 <role>" ‖ nonce): the relay's admission proof. */
export function relayProof(role: 'host' | 'device', priv: Buffer, eph: Buffer, nonce: Buffer): Buffer {
  return createHmac('sha256', dh(priv, eph)).update(`nb-relay-v1 ${role}`).update(nonce).digest();
}

const FATAL: Record<number, string> = {
  4401: 'the relay refused the host key proof',
  4402: 'the relay does not admit this host: the access key is missing, unknown or revoked',
  4409: 'another nota-bene remote with this host key is connected to the relay',
  4413: 'a frame was too large for the relay',
};

/** Close 4405: the access key already has as many computers connected as it may. Retried with backoff. */
export const KEY_LIMIT = 4405;
export const KEY_LIMIT_MESSAGE = 'this access key is already used on the most computers allowed';

/**
 * Events: `online`, `offline(code)` (every conn is reported `gone` first), `open(conn, deviceHash)`, `gone(conn)`,
 * `frame(conn, payload)`, `limited` (closed with 4405; a reconnect follows), `fatal(code, message)` (no reconnect follows).
 */
export class RelayClient extends EventEmitter {
  #o: { url: string; key: KeyPair; devices: () => string[]; ticket: () => Buffer | null; member: () => Buffer | null; backoff: { minMs: number; maxMs: number }; silenceMs: number };
  #ws: WebSocket | undefined;
  #online = false;
  #onlineAt = 0;
  #attempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #soon = false; // the next connection without backoff (reconnect)
  #conns = new Set<number>();

  /**
   * `silenceMs`: with nothing from the relay for this long (it pings every 30 s), the connection is presumed dead and
   * replaced. A laptop that slept through the relay's close never gets its FIN, and its socket would look alive forever.
   */
  /** `member`: the access key's seed, read for every connection (none: the hello is not signed, as for an open relay). */
  constructor(o: { url: string; key: KeyPair; devices: () => string[]; ticket: () => Buffer | null; member?: () => Buffer | null; backoff?: { minMs: number; maxMs: number }; silenceMs?: number }) {
    super();
    this.#o = { ...o, member: o.member ?? (() => null), backoff: o.backoff ?? { minMs: 1000, maxMs: 30_000 }, silenceMs: o.silenceMs ?? 75_000 };
  }

  get online(): boolean {
    return this.#online;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    const ws = this.#ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((r) => {
      ws.once('close', () => r());
      ws.close(1000);
    });
  }

  /** Drops the connection and connects again now, as a new access key needs. */
  reconnect(): void {
    if (this.#stopped) return;
    this.#attempt = 0;
    const ws = this.#ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      clearTimeout(this.#timer);
      this.#connect();
      return;
    }
    this.#soon = true;
    ws.close(1000);
  }

  setDevices(hashes: string[]): void {
    this.#control({ t: 'devices', devices: hashes });
  }

  setTicket(t: Buffer | null): void {
    this.#control({ t: 'ticket', ticket: t ? b64u(t) : null });
  }

  closeConn(conn: number): void {
    this.#control({ t: 'close', conn });
  }

  send(conn: number, payload: Buffer): void {
    if (!this.#online || !this.#conns.has(conn)) return;
    const head = Buffer.alloc(4);
    head.writeUInt32BE(conn);
    this.#ws!.send(Buffer.concat([head, payload]));
  }

  #control(m: object): void {
    if (this.#online) this.#ws!.send(JSON.stringify(m));
  }

  #connect(): void {
    const url = `${this.#o.url.replace(/\/+$/, '')}/v1/host`;
    const ws = new WebSocket(url, { maxPayload: 1024 * 1024 + 4, perMessageDeflate: false });
    this.#ws = ws;
    let greeted = false;
    let quiet: NodeJS.Timeout | undefined;
    const heard = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => ws.terminate(), this.#o.silenceMs);
    };
    ws.on('open', heard);
    ws.on('ping', heard);
    ws.on('message', (data: Buffer, binary: boolean) => {
      heard();
      if (binary) {
        if (!this.#online || data.length < 4) return;
        this.emit('frame', data.readUInt32BE(0), data.subarray(4));
        return;
      }
      let m: { t?: unknown; eph?: unknown; nonce?: unknown; conn?: unknown; device?: unknown };
      try {
        m = JSON.parse(data.toString('utf8')) as typeof m;
      } catch {
        return ws.close(4400);
      }
      if (!greeted) {
        if (m.t !== 'challenge' || typeof m.eph !== 'string' || typeof m.nonce !== 'string') return ws.close(4400);
        greeted = true;
        try {
          const eph = fromB64u(m.eph, 32);
          const nonce = fromB64u(m.nonce, 32);
          const proof = relayProof('host', this.#o.key.priv, eph, nonce);
          const ticket = this.#o.ticket();
          const seed = this.#o.member();
          const member = seed ? { member: b64u(memberPub(seed)), sig: b64u(memberSign(seed, nonce, eph, this.#o.key.pub)) } : {};
          ws.send(JSON.stringify({ t: 'hello', key: b64u(this.#o.key.pub), proof: b64u(proof), devices: this.#o.devices(), ...(ticket ? { ticket: b64u(ticket) } : {}), ...member }));
        } catch {
          ws.close(4400);
        }
        return;
      }
      if (m.t === 'ok' && !this.#online) {
        this.#online = true;
        this.#onlineAt = Date.now();
        this.emit('online');
      } else if (m.t === 'open' && typeof m.conn === 'number' && typeof m.device === 'string') {
        this.#conns.add(m.conn);
        this.emit('open', m.conn, m.device);
      } else if (m.t === 'gone' && typeof m.conn === 'number') {
        if (this.#conns.delete(m.conn)) this.emit('gone', m.conn);
      }
    });
    ws.on('error', () => { /* the close that follows decides */ });
    ws.on('close', (code: number) => {
      clearTimeout(quiet);
      if (this.#ws !== ws) return;
      const was = this.#online;
      this.#online = false;
      for (const c of [...this.#conns]) {
        this.#conns.delete(c);
        this.emit('gone', c);
      }
      if (was) {
        if (Date.now() - this.#onlineAt >= 60_000) this.#attempt = 0;
        this.emit('offline', code);
      }
      if (this.#stopped) return;
      const fatal = FATAL[code];
      if (fatal) {
        this.#stopped = true;
        this.emit('fatal', code, fatal);
        return;
      }
      if (code === KEY_LIMIT) this.emit('limited');
      const { minMs, maxMs } = this.#o.backoff;
      const delay = this.#soon ? 0 : Math.min(maxMs, minMs * 2 ** this.#attempt++) * (0.8 + Math.random() * 0.4);
      this.#soon = false;
      this.#timer = setTimeout(() => this.#connect(), delay);
    });
  }
}
