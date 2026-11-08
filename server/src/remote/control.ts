// The running connector's control socket, `<stateBase>/remote/control.sock` (mode 600 in a 700 folder): newline-delimited
// JSON both ways. It is the connector's only listener, and its presence is the single-instance lock.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { remoteDir } from './store.ts';

export type Msg = Record<string, unknown>;
const MAX_LINE = 64 * 1024;

export function socketPath(): string {
  const p = path.join(remoteDir(), 'control.sock');
  // sun_path holds 104 bytes on macOS, 108 on Linux (with the terminator)
  if (Buffer.byteLength(p) > 103) throw new Error(`the control socket path is too long for the system (${p}); use a shorter NOTA_BENE_HOME`);
  return p;
}

/** Splits a socket's input into JSON messages; a line that is not JSON, or one too long, ends the connection. */
function lines(sock: net.Socket, on: (m: Msg) => void): void {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d: string) => {
    buf += d;
    if (buf.length > MAX_LINE && !buf.includes('\n')) return void sock.destroy();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: unknown;
      try {
        m = JSON.parse(line);
      } catch {
        return void sock.destroy();
      }
      if (m && typeof m === 'object' && !Array.isArray(m)) on(m as Msg);
    }
  });
}

export const write = (sock: net.Socket, m: Msg): void => {
  if (!sock.destroyed) sock.write(`${JSON.stringify(m)}\n`);
};

/** Is a connector answering on the socket? A stale socket file (nobody listening) is removed. */
export async function running(): Promise<boolean> {
  const p = socketPath();
  if (!fs.existsSync(p)) return false;
  const up = await new Promise<boolean>((r) => {
    const s = net.connect(p);
    s.once('connect', () => {
      s.destroy();
      r(true);
    });
    s.once('error', () => r(false));
  });
  if (!up) fs.rmSync(p, { force: true });
  return up;
}

export async function serveControl(handle: (m: Msg, sock: net.Socket) => void): Promise<net.Server> {
  const p = socketPath();
  const srv = net.createServer((sock) => {
    sock.on('error', () => {});
    lines(sock, (m) => handle(m, sock));
  });
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(p, () => resolve());
  });
  fs.chmodSync(p, 0o600);
  return srv;
}

export type ControlClient = {
  send: (m: Msg) => void;
  /** every message received so far */
  events: Msg[];
  /** the first message not yet taken that matches (waits for it) */
  next: (match?: (m: Msg) => boolean, ms?: number) => Promise<Msg>;
  close: () => void;
  closed: Promise<void>;
};

export async function controlClient(): Promise<ControlClient> {
  const p = socketPath();
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(p);
    s.once('connect', () => resolve(s));
    s.once('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new Error('nota-bene remote is not running (start it with `nota-bene remote`)') : e));
  });
  sock.on('error', () => {});
  const events: Msg[] = [];
  const taken = new Set<number>();
  const waiters = new Set<() => void>();
  lines(sock, (m) => {
    events.push(m);
    for (const w of [...waiters]) w();
  });
  const closed = new Promise<void>((r) => sock.once('close', () => {
    r();
    for (const w of [...waiters]) w();
  }));
  const next = (match: (m: Msg) => boolean = () => true, ms = 10_000) => new Promise<Msg>((resolve, reject) => {
    const look = () => {
      const i = events.findIndex((m, k) => !taken.has(k) && match(m));
      if (i >= 0) {
        taken.add(i);
        done();
        resolve(events[i]!);
      } else if (sock.destroyed) {
        done();
        reject(new Error('the connector closed the connection'));
      }
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error('no answer from nota-bene remote'));
    }, ms);
    const done = () => {
      clearTimeout(timer);
      waiters.delete(look);
    };
    waiters.add(look);
    look();
  });
  return { send: (m) => write(sock, m), events, next, close: () => sock.destroy(), closed };
}
