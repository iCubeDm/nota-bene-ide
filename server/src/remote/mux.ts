// Streams inside one end-to-end channel (CHANNEL.md, Streams). A frame is the plaintext of one Noise transport message:
// type u8 | stream u32 BE | flags u8 | body. Flow control is HTTP/2's: every stream and the connection as a whole have a
// window of DATA bytes the receiver has granted; the sender stops at zero and the receiver grants more as its consumer
// finishes with the data. So a phone that stops reading throttles the host instead of filling the relay's queue.
import { EventEmitter } from 'node:events';

export const OPEN = 1, HEAD = 2, DATA = 3, END = 4, CLOSE = 5, CREDIT = 6;
export const FIN = 1, BIN = 2;

export const STREAM_WINDOW = 256 * 1024;
export const CONN_WINDOW = 512 * 1024;
export const MAX_CHUNK = 65535 - 16 - 6;
export const MAX_STREAMS = 64;
/** the most one reassembled message may hold (`collect`) */
export const MAX_COLLECT = 64 * 1024 * 1024;

export const CLOSED = 1000; // both sides ended normally
export const BAD_FRAME = 4900;
export const UNREACHABLE = 4902;
export const UNKNOWN_WINDOW = 4904;
export const TOO_LARGE = 4913;
export const TOO_MANY = 4929;

export type Frame =
  | { type: typeof OPEN | typeof HEAD | typeof CLOSE; stream: number; json: unknown }
  | { type: typeof DATA; stream: number; flags: number; data: Buffer }
  | { type: typeof END; stream: number }
  | { type: typeof CREDIT; stream: number; n: number };

export class MuxError extends Error {}

export function encodeFrame(f: Frame): Buffer {
  const head = Buffer.alloc(6);
  head[0] = f.type;
  head.writeUInt32BE(f.stream, 1);
  let body: Buffer;
  switch (f.type) {
    case DATA:
      head[5] = f.flags;
      body = f.data;
      break;
    case END:
      body = Buffer.alloc(0);
      break;
    case CREDIT:
      body = Buffer.alloc(4);
      body.writeUInt32BE(f.n);
      break;
    default:
      body = Buffer.from(JSON.stringify(f.json ?? {}));
  }
  return Buffer.concat([head, body]);
}

export function decodeFrame(b: Buffer): Frame {
  if (b.length < 6) throw new MuxError('frame too short');
  const type = b[0]!, stream = b.readUInt32BE(1), flags = b[5]!, body = b.subarray(6);
  switch (type) {
    case DATA:
      return { type, stream, flags, data: body };
    case END:
      return { type, stream };
    case CREDIT:
      if (body.length !== 4) throw new MuxError('bad credit frame');
      return { type, stream, n: body.readUInt32BE(0) };
    case OPEN: case HEAD: case CLOSE: {
      let json: unknown;
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        throw new MuxError('bad JSON in a frame');
      }
      return { type, stream, json };
    }
    default:
      throw new MuxError(`unknown frame type ${type}`);
  }
}

type Inbound = { chunk: Buffer; flags: number } | 'end';
export type DataHandler = (chunk: Buffer, fin: boolean, binary: boolean) => void | Promise<void>;

/**
 * One stream. Events: `head(json)`, `end` (the other side sends no more DATA), `close({code, reason})` (the stream is
 * over, either way), `drain`. Received DATA goes to `ondata`, one chunk at a time; its credit is returned when the
 * handler's promise settles.
 */
export class Stream extends EventEmitter {
  readonly id: number;
  #mux: Mux;
  #sendCredit = STREAM_WINDOW;
  recvWindow = STREAM_WINDOW;
  #consumed = 0;
  #out: { data: Buffer; flags: number }[] = [];
  #endWanted = false;
  #endSent = false;
  #remoteEnded = false;
  #closed = false;
  #in: Inbound[] = [];
  #delivering = false;
  #ondata: DataHandler | undefined;

  constructor(mux: Mux, id: number) {
    super();
    this.#mux = mux;
    this.id = id;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get ondata(): DataHandler | undefined {
    return this.#ondata;
  }

  set ondata(h: DataHandler | undefined) {
    this.#ondata = h;
    void this.#deliver();
  }

  head(json: unknown): void {
    if (!this.#closed) this.#mux.sendFrame({ type: HEAD, stream: this.id, json });
  }

  /** Queues one message (split into chunks); false while data waits for credit (then `drain`). */
  write(data: Buffer, binary = false): boolean {
    if (this.#closed || this.#endWanted) return false;
    const bin = binary ? BIN : 0;
    if (data.length === 0) this.#out.push({ data, flags: FIN | bin });
    for (let i = 0; i < data.length; i += MAX_CHUNK) {
      const end = Math.min(i + MAX_CHUNK, data.length);
      this.#out.push({ data: data.subarray(i, end), flags: (end === data.length ? FIN : 0) | bin });
    }
    this.pump();
    return this.#out.length === 0;
  }

  /** No more DATA from this side (sent once the queue has drained). */
  end(): void {
    if (this.#closed || this.#endWanted) return;
    this.#endWanted = true;
    this.pump();
  }

  close(code: number, reason?: string): void {
    if (this.#closed) return;
    this.#mux.sendFrame({ type: CLOSE, stream: this.id, json: reason === undefined ? { code } : { code, reason } });
    this.gone(code, reason);
  }

  get pending(): boolean {
    return this.#out.length > 0;
  }

  /** @internal */
  pump(): void {
    if (this.#closed) return;
    const blocked = this.#out.length > 0;
    while (this.#out.length > 0) {
      const head = this.#out[0]!;
      if (head.data.length === 0) {
        this.#mux.sendFrame({ type: DATA, stream: this.id, flags: head.flags, data: head.data });
        this.#out.shift();
        continue;
      }
      const allowed = Math.min(this.#sendCredit, this.#mux.sendCredit);
      if (allowed <= 0) break;
      const take = Math.min(allowed, head.data.length);
      const last = take === head.data.length;
      this.#mux.sendFrame({ type: DATA, stream: this.id, flags: last ? head.flags : head.flags & ~FIN, data: head.data.subarray(0, take) });
      this.#sendCredit -= take;
      this.#mux.sendCredit -= take;
      if (last) this.#out.shift();
      else head.data = head.data.subarray(take);
      if (this.#closed) return; // a send can fail the channel
    }
    if (this.#out.length > 0) return;
    if (this.#endWanted && !this.#endSent) {
      this.#endSent = true;
      this.#mux.sendFrame({ type: END, stream: this.id });
      this.#maybeFinish();
    }
    if (blocked && !this.#closed) this.emit('drain');
  }

  /** @internal */
  credit(n: number): void {
    this.#sendCredit += n;
    this.pump();
  }

  /** @internal */
  inbound(item: Inbound): void {
    if (this.#closed) return;
    this.#in.push(item);
    void this.#deliver();
  }

  async #deliver(): Promise<void> {
    if (this.#delivering) return;
    this.#delivering = true;
    try {
      while (!this.#closed && this.#in.length > 0) {
        const item = this.#in[0]!;
        if (item === 'end') {
          this.#in.shift();
          this.#remoteEnded = true;
          this.emit('end');
          this.#maybeFinish();
          continue;
        }
        const h = this.#ondata;
        if (!h) return;
        this.#in.shift();
        try {
          await h(item.chunk, (item.flags & FIN) !== 0, (item.flags & BIN) !== 0);
        } catch {
          this.close(BAD_FRAME, 'the receiver failed');
          return;
        }
        this.#grant(item.chunk.length);
      }
    } finally {
      this.#delivering = false;
    }
  }

  #grant(n: number): void {
    this.#mux.consumed(n);
    if (this.#closed || this.#remoteEnded) return;
    this.#consumed += n;
    if (this.#consumed >= STREAM_WINDOW / 2) {
      this.recvWindow += this.#consumed;
      this.#mux.sendFrame({ type: CREDIT, stream: this.id, n: this.#consumed });
      this.#consumed = 0;
    }
  }

  #maybeFinish(): void {
    if (this.#endSent && this.#remoteEnded && !this.#closed) this.gone(CLOSED);
  }

  /** @internal the stream is over: no frame is sent */
  gone(code: number, reason?: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#out = [];
    this.#in = [];
    this.#mux.forget(this);
    this.emit('close', reason === undefined ? { code } : { code, reason });
  }
}

/** One per channel. The phone opens streams (odd ids); the host only answers them (`onOpen`). */
export class Mux {
  #send: (plain: Buffer) => void;
  #onOpen: ((s: Stream, open: unknown) => void) | undefined;
  #onFail: ((code: number) => void) | undefined;
  #streams = new Map<number, Stream>();
  #nextId = 1;
  #failed = false;
  sendCredit = CONN_WINDOW;
  #recvWindow = CONN_WINDOW;
  #consumed = 0;

  constructor(o: { send: (plain: Buffer) => void; onOpen?: (s: Stream, open: unknown) => void; onFail?: (code: number) => void }) {
    this.#send = o.send;
    this.#onOpen = o.onOpen;
    this.#onFail = o.onFail;
  }

  get size(): number {
    return this.#streams.size;
  }

  /** @internal */
  sendFrame(f: Frame): void {
    if (!this.#failed) this.#send(encodeFrame(f));
  }

  open(open: unknown): Stream {
    const s = new Stream(this, this.#nextId);
    this.#nextId += 2;
    this.#streams.set(s.id, s);
    this.sendFrame({ type: OPEN, stream: s.id, json: open });
    return s;
  }

  receive(plain: Buffer): void {
    if (this.#failed) return;
    let f: Frame;
    try {
      f = decodeFrame(plain);
    } catch {
      this.fail(BAD_FRAME);
      return;
    }
    const s = this.#streams.get(f.stream);
    switch (f.type) {
      case OPEN:
        if (f.stream === 0 || s) return this.fail(BAD_FRAME);
        if (!this.#onOpen) return this.sendFrame({ type: CLOSE, stream: f.stream, json: { code: BAD_FRAME, reason: 'streams are opened by the phone' } });
        if (this.#streams.size >= MAX_STREAMS) return this.sendFrame({ type: CLOSE, stream: f.stream, json: { code: TOO_MANY } });
        {
          const n = new Stream(this, f.stream);
          this.#streams.set(n.id, n);
          this.#onOpen(n, f.json);
        }
        return;
      case DATA:
        if (f.data.length > this.#recvWindow || (s && f.data.length > s.recvWindow)) return this.fail(BAD_FRAME);
        this.#recvWindow -= f.data.length;
        if (!s) return this.consumed(f.data.length); // a stream that just closed: its bytes still count
        s.recvWindow -= f.data.length;
        s.inbound({ chunk: f.data, flags: f.flags });
        return;
      case END:
        s?.inbound('end');
        return;
      case HEAD:
        s?.emit('head', f.json);
        return;
      case CLOSE: {
        const j = (f.json ?? {}) as { code?: unknown; reason?: unknown };
        s?.gone(typeof j.code === 'number' ? j.code : BAD_FRAME, typeof j.reason === 'string' ? j.reason : undefined);
        return;
      }
      case CREDIT:
        if (f.stream === 0) {
          this.sendCredit += f.n;
          for (const x of [...this.#streams.values()]) if (x.pending) x.pump();
        } else s?.credit(f.n);
    }
  }

  /** @internal connection-level grant */
  consumed(n: number): void {
    if (this.#failed) return;
    this.#consumed += n;
    if (this.#consumed >= CONN_WINDOW / 2) {
      this.#recvWindow += this.#consumed;
      this.sendFrame({ type: CREDIT, stream: 0, n: this.#consumed });
      this.#consumed = 0;
    }
  }

  /** @internal */
  forget(s: Stream): void {
    if (this.#streams.get(s.id) === s) this.#streams.delete(s.id);
  }

  /** A protocol violation: every stream closes with `code`, and the channel's owner drops the connection. */
  fail(code: number): void {
    if (this.#failed) return;
    this.close(code);
    this.#failed = true;
    this.#onFail?.(code);
  }

  /** The channel is gone: every stream closes locally with `code`; nothing is sent. */
  close(code = UNREACHABLE, reason?: string): void {
    const all = [...this.#streams.values()];
    this.#failed = true;
    for (const s of all) s.gone(code, reason);
  }
}

/** Reassembles a stream's chunks into whole messages; past `max` bytes the stream is closed with 4913. */
export function collect(s: Stream, cb: (data: Buffer, binary: boolean) => void | Promise<void>, max = MAX_COLLECT): void {
  let parts: Buffer[] = [];
  let size = 0;
  s.ondata = async (chunk, fin, binary) => {
    size += chunk.length;
    if (size > max) {
      parts = [];
      s.close(TOO_LARGE, 'message too large');
      return;
    }
    parts.push(chunk);
    if (!fin) return;
    const data = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
    parts = [];
    size = 0;
    await cb(data, binary);
  };
}
