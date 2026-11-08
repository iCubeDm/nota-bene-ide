// A scripted phone for tests, and the reference behaviour for the app (CHANNEL.md): Noise initiator with the host key
// pinned, the mux as the side that opens streams, and the stream kinds. `relayPhone` adds the relay's device admission.
import WebSocket from 'ws';
import { CipherState, Handshake, PROLOGUE, generateKeyPair, type KeyPair } from './noise.ts';
import { collect, DATA, decodeFrame, Mux, type Stream } from './mux.ts';
import { relayProof } from './relayClient.ts';
import { b64u, fromB64u, hostId } from './store.ts';

export type HttpAnswer = { status: number; headers: Record<string, string>; body: Buffer };

export class Phone {
  readonly key: KeyPair;
  #hs: Handshake;
  #send: (b: Buffer) => void;
  #tx: CipherState | undefined;
  #rx: CipherState | undefined;
  mux: Mux | undefined;
  /** DATA body bytes received from the host */
  dataIn = 0;
  /** what the host answered in handshake message 2 */
  welcome: unknown;
  ready: Promise<void>;
  #ready!: () => void;

  constructor(o: { hostPub: Buffer; send: (b: Buffer) => void; key?: KeyPair }) {
    this.key = o.key ?? generateKeyPair();
    this.#send = o.send;
    this.#hs = Handshake.initiator({ s: this.key, rs: o.hostPub, prologue: PROLOGUE });
    this.ready = new Promise((r) => (this.#ready = r));
  }

  /** Sends handshake message 1 with `payload` (`{v: 1, name?, pair?}`). */
  hello(payload: Record<string, unknown> = { v: 1 }): void {
    this.#send(this.#hs.writeMessage(Buffer.from(JSON.stringify(payload))));
  }

  receive(b: Buffer): void {
    if (!this.#rx) {
      this.welcome = JSON.parse(this.#hs.readMessage(b).toString('utf8'));
      const { send, recv } = this.#hs.split();
      this.#tx = send;
      this.#rx = recv;
      this.mux = new Mux({ send: (p) => this.#send(this.#tx!.encrypt(p)) });
      this.#ready();
      return;
    }
    const plain = this.#rx.decrypt(b);
    const f = decodeFrame(plain);
    if (f.type === DATA) this.dataIn += f.data.length;
    this.mux!.receive(plain);
  }

  open(o: unknown): Stream {
    return this.mux!.open(o);
  }

  /** One HTTP request through the channel. */
  http(port: number, method: string, path: string, o: { headers?: Record<string, string>; body?: Buffer } = {}): Promise<HttpAnswer> {
    const s = this.open({ kind: 'http', port, method, path, ...(o.headers ? { headers: o.headers } : {}) });
    if (o.body) s.write(o.body);
    s.end();
    return new Promise((resolve, reject) => {
      let head: { status: number; headers: Record<string, string> } | undefined;
      const parts: Buffer[] = [];
      s.on('head', (h: { status: number; headers: Record<string, string> }) => (head = h));
      s.ondata = (chunk) => { parts.push(chunk); };
      s.on('close', (c: { code: number; reason?: string }) => {
        if (c.code === 1000 && head) resolve({ ...head, body: Buffer.concat(parts) });
        else reject(Object.assign(new Error(`stream closed ${c.code} ${c.reason ?? ''}`), { code: c.code }));
      });
    });
  }

  /** A WebSocket to a window through the channel: text messages are parsed as JSON. */
  ws(port: number, path: string) {
    const s = this.open({ kind: 'ws', port, path });
    const events: { kind?: string; [k: string]: unknown }[] = [];
    const closed = new Promise<{ code: number; reason?: string }>((r) => s.on('close', r));
    collect(s, (data, binary) => {
      if (!binary) events.push(JSON.parse(data.toString('utf8')) as { kind?: string });
    });
    return { stream: s, events, closed, send: (m: unknown) => s.write(Buffer.from(JSON.stringify(m))) };
  }

  /** The host stream: every `windows` message the host sent, newest last. */
  host() {
    const s = this.open({ kind: 'host' });
    const lists: { port: number; provider: string; root: string; [k: string]: unknown }[][] = [];
    collect(s, (data) => {
      const m = JSON.parse(data.toString('utf8')) as { t: string; windows: (typeof lists)[number] };
      if (m.t === 'windows') lists.push(m.windows);
    });
    return { stream: s, lists };
  }
}

/** A phone through a relay: device admission (listed key, or the pairing ticket), then the channel over it. */
export function relayPhone(o: { url: string; hostPub: Buffer; key?: KeyPair; ticket?: Buffer; hello?: Record<string, unknown> }) {
  const ws = new WebSocket(`${o.url}/v1/device?host=${hostId(o.hostPub)}`, { perMessageDeflate: false });
  const phone = new Phone({ hostPub: o.hostPub, ...(o.key ? { key: o.key } : {}), send: (b) => ws.send(b) });
  const state: { conn?: number; closed?: number } = {};
  const closed = new Promise<number>((r) => ws.on('close', (code) => { state.closed = code; r(code); }));
  ws.on('error', () => {});
  ws.on('message', (data: Buffer, binary: boolean) => {
    if (binary) {
      try {
        phone.receive(data);
      } catch {
        ws.terminate();
      }
      return;
    }
    const m = JSON.parse(data.toString('utf8')) as { t: string; eph?: string; nonce?: string; conn?: number };
    if (m.t === 'challenge') {
      const proof = relayProof('device', phone.key.priv, fromB64u(m.eph!, 32), fromB64u(m.nonce!, 32));
      ws.send(JSON.stringify({ t: 'hello', key: b64u(phone.key.pub), proof: b64u(proof), ...(o.ticket ? { ticket: b64u(o.ticket) } : {}) }));
    } else if (m.t === 'ok') {
      state.conn = m.conn;
      phone.hello(o.hello ?? { v: 1 });
    }
  });
  return { phone, ws, state, closed };
}
