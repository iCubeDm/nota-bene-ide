// A scripted phone for tests: the production device end (hostLink.ts) with helpers for the stream kinds of CHANNEL.md.
// `relayPhone` adds the relay's device admission.
import { DeviceEnd, relayDevice } from './hostLink.ts';
import { generateKeyPair, type KeyPair } from './noise.ts';
import { collect, DATA, decodeFrame } from './mux.ts';

export type HttpAnswer = { status: number; headers: Record<string, string>; body: Buffer };

export class Phone extends DeviceEnd {
  /** DATA body bytes received from the host */
  dataIn = 0;

  constructor(o: { hostPub: Buffer; send: (b: Buffer) => void; key?: KeyPair }) {
    super({ hostPub: o.hostPub, send: o.send, key: o.key ?? generateKeyPair() });
  }

  protected override deliver(plain: Buffer): void {
    const f = decodeFrame(plain);
    if (f.type === DATA) this.dataIn += f.data.length;
    super.deliver(plain);
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
      if (m.t !== 'windows') return;
      lists.push(m.windows);
    });
    return { stream: s, lists };
  }
}

/** A phone through a relay: device admission (listed key, or the pairing ticket), then the channel over it. */
export function relayPhone(o: { url: string; hostPub: Buffer; key?: KeyPair; ticket?: Buffer; hello?: Record<string, unknown> }) {
  const { end: phone, ...rest } = relayDevice(o, (send) => new Phone({ hostPub: o.hostPub, send, ...(o.key ? { key: o.key } : {}) }));
  return { phone, ...rest };
}
