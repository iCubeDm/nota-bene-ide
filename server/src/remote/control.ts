// The running connector's control socket, `<stateBase>/remote/control.sock` (mode 600 in a 700 folder): newline-delimited
// JSON both ways. It is the connector's only listener, and its presence is the single-instance lock.
//
// Windows has no unix sockets: the connector listens on the named pipe `\\.\pipe\nota-bene-remote-<16 hex of SHA-256 of the
// real state base path>`. A pipe leaves no file (a connector runs when a connect succeeds) and gets the default ACL, which
// may let other local users open it, so the mode-600 trust is replaced by a handshake on the per-home secret
// `<stateBase>/remote/control-secret`: the connector sends a fresh nonce, the client's first message proves it holds the
// secret for that nonce and one of its own, and the connector proves it back. The secret never crosses the pipe, so a
// process that takes the pipe name before the connector learns nothing it could use later.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathKey, realpathNative } from '../platform.ts';
import { stateBaseDir } from '../state.ts';
import { controlSecret, remoteDir } from './store.ts';

export type Msg = Record<string, unknown>;
const MAX_LINE = 64 * 1024;
/** How long either side of the Windows pipe handshake waits for the other. */
const AUTH_WAIT_MS = 5000;
const isPipe = (): boolean => process.platform === 'win32';

export function socketPath(): string {
  if (isPipe()) {
    remoteDir(); // the folder (and the state base) exists, so its real path is the one every later run sees
    const id = createHash('sha256').update(pathKey(realpathNative(stateBaseDir()))).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\nota-bene-remote-${id}`;
  }
  const p = path.join(remoteDir(), 'control.sock');
  // sun_path holds 104 bytes on macOS, 108 on Linux (with the terminator)
  if (Buffer.byteLength(p) > 103) throw new Error(`the control socket path is too long for the system (${p}); use a shorter NOTA_BENE_HOME`);
  return p;
}

const HEX32 = /^[0-9a-f]{64}$/;
/** What each side of the pipe handshake sends for the connector's nonce `ns` and the client's `nc`. */
const proof = (secret: string, side: 'client' | 'server', ns: string, nc: string): Buffer =>
  createHmac('sha256', Buffer.from(secret, 'hex')).update(`nb-control-${side}\n${ns}\n${nc}`).digest();
const proofOk = (got: unknown, want: Buffer): boolean => typeof got === 'string' && HEX32.test(got) && timingSafeEqual(Buffer.from(got, 'hex'), want);

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
  if (!isPipe() && !fs.existsSync(p)) return false;
  const up = await new Promise<boolean>((r) => {
    const s = net.connect(p);
    s.once('connect', () => {
      s.destroy();
      r(true);
    });
    s.once('error', () => r(false));
  });
  if (!up && !isPipe()) fs.rmSync(p, { force: true });
  return up;
}

/** The pipe's side of the handshake: nothing reaches `handle` before the first message proved the secret for our nonce. */
function gate(sock: net.Socket, secret: string, handle: (m: Msg) => void): (m: Msg) => void {
  const ns = randomBytes(32).toString('hex');
  let authed = false;
  const timer = setTimeout(() => sock.destroy(), AUTH_WAIT_MS);
  sock.once('close', () => clearTimeout(timer));
  write(sock, { t: 'challenge', nonce: ns });
  return (m) => {
    if (authed) return handle(m);
    clearTimeout(timer);
    const nc = m.nonce;
    if (m.op !== 'auth' || typeof nc !== 'string' || !HEX32.test(nc) || !proofOk(m.proof, proof(secret, 'client', ns, nc))) return void sock.destroy();
    authed = true;
    write(sock, { t: 'auth', proof: proof(secret, 'server', ns, nc).toString('hex') });
  };
}

export async function serveControl(handle: (m: Msg, sock: net.Socket) => void): Promise<net.Server> {
  const p = socketPath();
  const secret = isPipe() ? controlSecret() : undefined;
  const open = new Set<net.Socket>();
  const srv = net.createServer((sock) => {
    open.add(sock);
    sock.once('close', () => open.delete(sock));
    sock.on('error', () => {});
    const on = (m: Msg) => handle(m, sock);
    lines(sock, secret === undefined ? on : gate(sock, secret, on));
  });
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(p, () => resolve());
  });
  if (!isPipe()) fs.chmodSync(p, 0o600);
  clients.set(srv, open);
  return srv;
}

const clients = new WeakMap<net.Server, Set<net.Socket>>();

/** Stops listening and drops every client still connected (a window's status poll, a pairing); the socket file goes too (a pipe leaves none). */
export async function closeControl(srv: net.Server): Promise<void> {
  const closed = new Promise((r) => srv.close(r));
  for (const s of clients.get(srv) ?? []) s.destroy();
  await closed;
  if (!isPipe()) fs.rmSync(socketPath(), { force: true });
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

/** The client's side of the pipe handshake: `take` sees every message until it resolves `done` (or rejects it). */
function handshake(sock: net.Socket, secret: string): { take: (m: Msg) => boolean; done: Promise<void> } {
  const nc = randomBytes(32).toString('hex');
  let ns = '';
  let over = false;
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const done = new Promise<void>((y, n) => { resolve = y; reject = n; });
  const fail = (why: string) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    sock.destroy();
    reject(new Error(why));
  };
  const timer = setTimeout(() => fail('no answer from nota-bene remote'), AUTH_WAIT_MS);
  sock.once('close', () => fail('nota-bene remote closed the connection (it holds another control-secret?)'));
  const take = (m: Msg): boolean => {
    if (over) return false;
    if (!ns) {
      if (m.t !== 'challenge' || typeof m.nonce !== 'string' || !HEX32.test(m.nonce)) fail('what answers on the control pipe is not nota-bene remote');
      else {
        ns = m.nonce;
        write(sock, { op: 'auth', nonce: nc, proof: proof(secret, 'client', ns, nc).toString('hex') });
      }
    } else if (m.t !== 'auth' || !proofOk(m.proof, proof(secret, 'server', ns, nc))) {
      fail('what answers on the control pipe is not nota-bene remote');
    } else {
      over = true;
      clearTimeout(timer);
      resolve();
    }
    return true;
  };
  return { take, done };
}

export async function controlClient(): Promise<ControlClient> {
  const p = socketPath();
  const secret = isPipe() ? controlSecret() : undefined;
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(p);
    s.once('connect', () => resolve(s));
    s.once('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new Error('nota-bene remote is not running (start it with `nota-bene remote`)') : e));
  });
  sock.on('error', () => {});
  const hs = secret === undefined ? undefined : handshake(sock, secret);
  const events: Msg[] = [];
  const taken = new Set<number>();
  const waiters = new Set<() => void>();
  lines(sock, (m) => {
    if (hs?.take(m)) return;
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
  await hs?.done;
  return { send: (m) => write(sock, m), events, next, close: () => sock.destroy(), closed };
}
