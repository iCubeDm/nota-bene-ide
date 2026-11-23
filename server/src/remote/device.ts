// One phone connection (one relay conn): the Noise responder, the pairing check, then the mux and the stream kinds of
// CHANNEL.md proxied to the windows on 127.0.0.1. The connector adds the credentials (the window's helper bearer); the
// phone never holds one. Window → phone reads only as fast as the stream's credit allows (pause/resume upstream).
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { AGENT_ID, HOST_WINDOW_INFO, type AgentProvider, type HostStreamMessage, type HostWindow } from '@nota-bene/shared';
import WebSocket from 'ws';
import { agentPrefix } from '../http.ts';
import { windowKey } from '../windows.ts';
import { windowInfo, type ProvedWindow, type Windows } from './discover.ts';
import { BAD_FRAME, Mux, TOO_LARGE, UNKNOWN_WINDOW, UNREACHABLE, type Stream } from './mux.ts';
import { CipherState, Handshake, MAX_PLAINTEXT, PROLOGUE, type KeyPair } from './noise.ts';
import { deviceHash, fromB64u, pairProof } from './store.ts';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const FORWARDED = ['accept', 'content-type', 'range', 'if-none-match', 'if-range', 'if-modified-since'];
const DROPPED = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding']);
export const MAX_BODY = 32 * 1024 * 1024; // a request body is buffered whole, so a refused bearer can be retried
const INFO_MS = 5000;

/**
 * A path the proxy sends on: one of the window's own routes, never another host, never the control routes, never the
 * remote-access routes (a paired phone would pair another device, revoke phones or turn access off unseen), never the
 * project switcher's (they start windows, create folders and hand out other windows' logins: the desktop's until phase 2,
 * and `/system/remote` reaches the computers this one is paired with),
 * never `/os/` (Show in Finder and Open act on this computer's desktop; issue 461).
 */
export const goodPath = (p: unknown): p is string =>
  typeof p === 'string' && p.length <= 8192 && /^\/[\x21-\x7e]*$/.test(p) && !/[\\#]/.test(p) && goodRoute(unprefixed(p));

/** epic 383: the path below an agent's prefix (`/a/<id>`), which the window answers as if it came at the top (http.ts agentPrefix) */
export const unprefixed = (p: string): string => agentPrefix(p)?.rest ?? p;

// `mcp`: the agent bus (epic 383 2f) serves this computer's agents only
const goodRoute = (p: string): boolean => !p.startsWith('//') && !/^\/(control|remote|mcp)(\/|\?|$)/i.test(p)
  && !/^\/system\/(projects|folders|agents|remote)(\/|\?|$)/i.test(p) // issue 297: `remote` opens proxies to other computers
  && !/^\/(os|system\/shortcut)(\/|\?|$)/i.test(p); // issue 461: Show in Finder / Open, and the app icon, act on this computer's desktop

/** A name to show and save: control and bidi-override characters dropped, at most 64 characters; none when nothing is left. */
export function cleanName(raw: string): string | undefined {
  const n = [...raw.replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '').trim()].slice(0, 64).join('').trim();
  return n || undefined;
}

/** What this computer calls itself, for the phone's host label: `os.hostname()` without a trailing `.local`, cleaned. */
export function computerName(raw: string = os.hostname()): string | undefined {
  return cleanName(cleanName(raw)?.replace(/\.local$/i, '') ?? '');
}

/** A server's agents (its /info's `agents`), well formed only. */
function agentsOf(info: Record<string, unknown> | null): { id: string; provider: AgentProvider }[] {
  if (!info || !Array.isArray(info.agents)) return [];
  return info.agents.flatMap((x: unknown) => {
    const { id, provider } = (x ?? {}) as { id?: unknown; provider?: unknown };
    return typeof id === 'string' && AGENT_ID.test(id) && (provider === 'claude' || provider === 'codex' || provider === 'omp') ? [{ id, provider }] : [];
  });
}

/**
 * The ids of a list of windows (issue 511): `windowKey(provider, root)`. One window per folder and agent is the launcher's
 * rule, not an invariant (an unlocked or inner launch, a dev server), so among windows of one key the lowest port keeps
 * the bare id and the others get `<id>:<port>`: every phone sees the same ids.
 */
function windowIds(list: readonly ProvedWindow[]): string[] {
  const keys = list.map((w) => windowKey(w.provider, w.root));
  const lowest = new Map<string, number>();
  list.forEach((w, i) => lowest.set(keys[i]!, Math.min(w.port, lowest.get(keys[i]!) ?? Infinity)));
  return list.map((w, i) => (lowest.get(keys[i]!) === w.port ? keys[i]! : `${keys[i]}:${w.port}`));
}

export type DeviceOptions = {
  hostKey: KeyPair;
  /** one Noise message to the phone */
  send: (b: Buffer) => void;
  /** the connection must go (a failed handshake, a bad message): the connector closes the relay conn */
  drop: () => void;
  windows: Windows;
  /** the pairing in flight (or just used), if any */
  pairing: () => { secret: Buffer } | null;
  /** an unlisted phone proved the pairing code: false refuses it (the code was already used) */
  onPaired: (pub: Buffer, name?: string) => boolean;
  isListed: (pub: Buffer) => boolean;
  /** the device hash the relay announced for this conn: the phone's Noise key must be the one it names */
  deviceHash?: string;
  /** the computer's name, sent in the welcome so the phone can label this host (default: `computerName()`) */
  hostName?: string;
};

/** A socket from another device never follows the launcher (epic 383, `go=1`): only a page on this computer is moved. */
export function forwardedWsPath(p: string): string {
  const q = p.indexOf('?');
  if (q < 0) return p;
  const params = new URLSearchParams(p.slice(q + 1));
  params.delete('go');
  const rest = params.toString();
  return rest ? `${p.slice(0, q)}?${rest}` : p.slice(0, q);
}

export class DeviceChannel {
  #o: DeviceOptions;
  #hs: Handshake | undefined;
  #tx: CipherState | undefined;
  #rx: CipherState | undefined;
  #mux: Mux | undefined;
  #pub: Buffer | undefined;
  #dead = false;
  #cleanups = new Set<() => void>();

  constructor(o: DeviceOptions) {
    this.#o = o;
    this.#hs = Handshake.responder({ s: o.hostKey, prologue: PROLOGUE });
  }

  get devicePub(): Buffer | undefined {
    return this.#pub;
  }

  /** what this phone's streams hold for it, waiting for its credit (bounded by pausing the windows) */
  get queuedBytes(): number {
    return this.#mux?.queuedBytes ?? 0;
  }

  receive(b: Buffer): void {
    if (this.#dead) return;
    try {
      if (this.#hs) return this.#handshake(b);
      this.#mux!.receive(this.#rx!.decrypt(b));
    } catch {
      this.#fail();
    }
  }

  /** Tears the channel down: every stream and its upstream connection closes; nothing more is sent. */
  close(): void {
    if (this.#dead) return;
    this.#dead = true;
    this.#mux?.close(UNREACHABLE, 'channel closed');
    for (const c of [...this.#cleanups]) c();
  }

  #fail(): void {
    if (this.#dead) return;
    this.close();
    this.#o.drop();
  }

  #handshake(b: Buffer): void {
    const hs = this.#hs!;
    const payload = JSON.parse(hs.readMessage(b).toString('utf8')) as { v?: unknown; name?: unknown; pair?: unknown };
    const pub = hs.remoteStatic!;
    if (payload?.v !== 1) return this.#fail();
    if (this.#o.deviceHash !== undefined && deviceHash(pub) !== this.#o.deviceHash) return this.#fail();
    const name = typeof payload.name === 'string' ? cleanName(payload.name) : undefined;
    if (!this.#o.isListed(pub)) {
      const p = this.#o.pairing();
      if (!p || typeof payload.pair !== 'string') return this.#fail();
      let proof: Buffer;
      try {
        proof = fromB64u(payload.pair, 32);
      } catch {
        return this.#fail();
      }
      if (!timingSafeEqual(proof, pairProof(p.secret, pub))) return this.#fail();
      if (!this.#o.onPaired(pub, name)) return this.#fail();
    }
    this.#pub = pub;
    const host = this.#o.hostName ?? computerName();
    const reply = hs.writeMessage(Buffer.from(JSON.stringify({ v: 1, ok: true, ...(host ? { host } : {}) })));
    const { send, recv } = hs.split();
    this.#hs = undefined;
    this.#tx = send;
    this.#rx = recv;
    this.#mux = new Mux({
      send: (plain) => {
        if (this.#dead) return;
        if (plain.length > MAX_PLAINTEXT) throw new Error('frame too large');
        this.#o.send(this.#tx!.encrypt(plain));
      },
      onOpen: (s, open) => this.#open(s, open),
      onFail: () => this.#fail(),
    });
    this.#o.send(reply);
  }

  #track(s: Stream, cleanup: () => void): void {
    this.#cleanups.add(cleanup);
    s.once('close', () => {
      this.#cleanups.delete(cleanup);
      cleanup();
    });
  }

  #open(s: Stream, open: unknown): void {
    try {
      this.#openKind(s, open);
    } catch {
      s.close(BAD_FRAME, 'bad request'); // one bad stream, not the channel
    }
  }

  #openKind(s: Stream, open: unknown): void {
    const o = (open && typeof open === 'object' ? open : {}) as { kind?: unknown; port?: unknown; path?: unknown; method?: unknown; headers?: unknown };
    if (o.kind === 'host') return this.#hostStream(s);
    if (o.kind !== 'ws' && o.kind !== 'http' && o.kind !== 'public') return s.close(BAD_FRAME, 'unknown stream kind');
    if (!goodPath(o.path)) return s.close(BAD_FRAME, 'bad path');
    const w = typeof o.port === 'number' ? this.#o.windows.get(o.port) : undefined;
    if (!w) return s.close(UNKNOWN_WINDOW, 'no such window');
    if (o.kind === 'ws') {
      if (!/^\/ws(\?|$)/.test(unprefixed(o.path))) return s.close(BAD_FRAME, 'bad path');
      return this.#wsStream(s, w, forwardedWsPath(o.path));
    }
    const method = typeof o.method === 'string' ? o.method.toUpperCase() : '';
    if (!METHODS.has(method)) return s.close(BAD_FRAME, 'bad method');
    // issue 297: a request without the window's credentials (what it serves anyone: the app shell), for a desktop proxy's
    // page that has not logged in to it yet
    const anon = o.kind === 'public';
    if (anon && method !== 'GET' && method !== 'HEAD') return s.close(BAD_FRAME, 'bad method');
    const headers: Record<string, string> = {};
    if (o.headers && typeof o.headers === 'object') {
      for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) {
        if (typeof v === 'string' && FORWARDED.includes(k.toLowerCase())) headers[k.toLowerCase()] = v;
      }
    }
    this.#httpStream(s, w, method, o.path, headers, anon);
  }

  #hostStream(s: Stream): void {
    let last = '';
    const push = async () => {
      const list = this.#o.windows.list();
      const tops = await Promise.all(list.map((w) => windowInfo(w)));
      // epic 383: each server's agents, by its /info's `agents`, read under their prefix (an older server's top is its first)
      const each = await Promise.all(list.map((w, i) => Promise.all(agentsOf(tops[i]).map(async (a) => ({ a, info: a.id === tops[i]?.agent ? tops[i]! : await windowInfo(w, fetch, `/a/${a.id}`) })))));
      if (s.closed) return;
      const ids = windowIds(list);
      const fields = (info: Record<string, unknown>) => Object.fromEntries(HOST_WINDOW_INFO.filter((k) => info[k] !== undefined).map((k) => [k, info[k]]));
      // an agent that went between the two reads, or answers no folder, is left out until the next look
      const answered = each.map((xs) => xs.filter(({ info }) => info && typeof info.root === 'string') as { a: { id: string; provider: AgentProvider }; info: Record<string, unknown> & { root: string } }[]);
      // `windows`: each server by its first agent (issue 639: every one under its prefix); `agents`: the others
      const windows = list.map((w, i): HostWindow => {
        const first = answered[i]![0];
        return first ? { id: ids[i]!, port: w.port, agent: first.a.id, provider: first.a.provider, root: first.info.root, ...fields(first.info) } : { id: ids[i]!, port: w.port, provider: w.provider, root: w.root };
      });
      const agents = list.flatMap((w, i) => answered[i]!.slice(1).map(({ a, info }): HostWindow => ({ id: windowKey(a.provider, info.root), port: w.port, agent: a.id, provider: a.provider, root: info.root, ...fields(info) })));
      const m = JSON.stringify({ t: 'windows', windows, ...(agents.length ? { agents } : {}) } satisfies HostStreamMessage);
      if (m === last) return;
      last = m;
      s.write(Buffer.from(m));
    };
    const onChange = () => void push();
    this.#o.windows.on('change', onChange);
    const timer = setInterval(onChange, INFO_MS);
    this.#track(s, () => {
      clearInterval(timer);
      this.#o.windows.off('change', onChange);
    });
    s.ondata = () => {}; // the phone sends nothing here
    void push();
  }

  #wsStream(s: Stream, w: ProvedWindow, path: string): void {
    const up = new WebSocket(`ws://127.0.0.1:${w.port}${path}`, { headers: { authorization: w.bearer }, perMessageDeflate: false });
    const opened = new Promise<boolean>((r) => {
      up.once('open', () => r(true));
      up.once('close', () => r(false));
    });
    up.on('unexpected-response', (_req, res) => {
      res.resume();
      if (res.statusCode === 401) void this.#o.windows.reprove(w.port);
      s.close(UNKNOWN_WINDOW, 'the window refused the connection');
      up.terminate();
    });
    let wasOpen = false;
    up.once('open', () => (wasOpen = true));
    // after the open, an error is the window going away (a reset before the close frame)
    up.on('error', () => s.close(wasOpen ? UNKNOWN_WINDOW : UNREACHABLE, wasOpen ? 'the window has gone' : 'the window could not be reached'));
    up.on('message', (data: Buffer, binary: boolean) => {
      if (!s.write(data, binary)) up.pause();
    });
    s.on('drain', () => up.resume());
    up.on('close', (code: number, reason: Buffer) => s.close(code === 1005 || code === 1006 ? UNKNOWN_WINDOW : code, reason.toString() || undefined));
    s.ondata = async (chunk, fin, binary) => {
      if (!(await opened) || up.readyState !== WebSocket.OPEN) return;
      await new Promise<void>((r) => up.send(chunk, { binary, fin }, () => r()));
    };
    this.#track(s, () => {
      if (up.readyState === WebSocket.OPEN) up.close(1000);
      else up.terminate();
    });
  }

  #httpStream(s: Stream, w0: ProvedWindow, method: string, path: string, headers: Record<string, string>, anon: boolean): void {
    const parts: Buffer[] = [];
    let size = 0;
    let req: http.ClientRequest | undefined;
    s.ondata = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) return s.close(TOO_LARGE, 'request body too large');
      parts.push(chunk);
    };
    this.#track(s, () => req?.destroy());
    const send = (w: ProvedWindow, retried: boolean) => {
      const body = Buffer.concat(parts);
      const h: Record<string, string> = { ...headers, ...(anon ? {} : { authorization: w.bearer }), host: `127.0.0.1:${w.port}` };
      if (method !== 'GET' && method !== 'HEAD') h.origin = `http://127.0.0.1:${w.port}`;
      if (body.length > 0 || (method !== 'GET' && method !== 'HEAD')) h['content-length'] = String(body.length);
      try {
        req = http.request({ host: '127.0.0.1', port: w.port, method, path, headers: h }, (res) => this.#answer(s, res, w, retried || anon, send));
      } catch {
        return s.close(BAD_FRAME, 'bad request');
      }
      req.on('error', (e: NodeJS.ErrnoException) => {
        if (s.closed) return;
        // only a refused connection is sure to have done nothing: a reset may come after the window acted on it
        if (!retried && e.code === 'ECONNREFUSED') {
          void this.#o.windows.reprove(w.port).then((again) => (s.closed ? undefined : again ? send(again, true) : s.close(UNKNOWN_WINDOW, 'the window has gone')));
        } else s.close(UNREACHABLE, 'the window could not be reached');
      });
      req.end(body);
    };
    s.once('end', () => {
      if (!s.closed) send(w0, false);
    });
  }

  #answer(s: Stream, res: http.IncomingMessage, w: ProvedWindow, retried: boolean, send: (w: ProvedWindow, retried: boolean) => void): void {
    if (res.statusCode === 401 && !retried) {
      res.resume();
      void this.#o.windows.reprove(w.port).then((again) => {
        if (s.closed) return;
        if (again) send(again, true);
        else s.close(UNKNOWN_WINDOW, 'the window has gone');
      });
      return;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (v !== undefined && !DROPPED.has(k)) out[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    s.head({ status: res.statusCode ?? 502, headers: out });
    res.on('data', (c: Buffer) => {
      if (!s.write(c)) res.pause();
    });
    s.on('drain', () => res.resume());
    res.on('end', () => s.end());
    res.on('error', () => s.close(UNREACHABLE, 'the response broke off'));
  }
}
