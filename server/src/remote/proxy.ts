// A window of a paired computer on a loopback listener of this one (issue 297): the desktop client. The page and the
// window's routes come from that computer over the channel (CHANNEL.md, `http`/`public`/`ws` streams); this listener runs
// its own auth as a window does (auth.ts: its own token, nonce, login, cookie and key) and strips it, so the other computer
// gets only the channel's helper bearer.
//
// It serves on the host name `localhost` while this computer's windows stay on `127.0.0.1`: cookies are scoped by host,
// not by port, so the other computer's pages and this one's windows never share a cookie, and they are different sites for
// SameSite. A page here never obtains a credential for this computer's windows: the switch to one goes by a top-level
// navigation to `/system/remote/enter`, whose redirect (the login in its fragment) page code cannot read.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { authenticated, cookieRoute, KEY_PROTOCOL, loginCredential, loginRoute, newNonce } from '../auth.ts';
import { FORWARDED, goodPath, MAX_BODY } from './device.ts';
import { CLOSED, collect, TOO_LARGE, UNREACHABLE, type Stream } from './mux.ts';

/** How long a listener stays after its last connection closed (also when the tab never came). */
export const LINGER_MS = 60_000;

/** Where `/system/remote/enter` goes: another window of a paired computer, or one of this computer's. */
export type EnterTarget = { host: string; port: number } | { provider: string; port: number; root: string };

export type ProxyOptions = {
  /** a stream to the paired computer, null while its channel is down */
  open: (o: unknown) => Stream | null;
  /** the window's port on that computer */
  port: number;
  computer: { host: string; name: string };
  /** this computer's projects list with the paired computers' windows (projects.ts), this one current */
  projects: () => Promise<unknown>;
  /** the login URL of that window, or why not */
  enter: (to: EnterTarget) => Promise<{ url: string } | { error: string }>;
  onClose: () => void;
  lingerMs?: number;
};

function text(res: http.ServerResponse, status: number, body: string): void {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function json(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
/** A close code a WebSocket may send (the window's own pass through; 1005/1006 never come, the host maps them). */
const sendable = (c: number): number => (c === 1000 || c === 1001 || (c >= 3000 && c <= 4999) ? c : 1011);

export class WindowProxy {
  readonly #o: ProxyOptions;
  readonly #token = randomBytes(32).toString('hex');
  readonly #nonce = newNonce();
  readonly #server: http.Server;
  readonly #wss: WebSocketServer;
  readonly #sockets = new Set<Socket>();
  #port = 0;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(o: ProxyOptions) {
    this.#o = o;
    const login = loginRoute(this.#token, () => this.#port, this.#nonce);
    this.#server = http.createServer((req, res) => {
      try {
        this.#request(req, res, login);
      } catch {
        text(res, 500, 'internal error');
      }
    });
    // the page's key travels as the `nb.<key>` subprotocol: echo it or the browser drops the socket
    this.#wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: (ps) => [...ps].find((p) => p.startsWith(KEY_PROTOCOL)) ?? false });
    this.#server.on('upgrade', (req: http.IncomingMessage, sock: Socket, head: Buffer) => this.#upgrade(req, sock, head));
    this.#server.on('connection', (sock: Socket) => {
      this.#sockets.add(sock);
      clearTimeout(this.#timer);
      sock.once('close', () => {
        this.#sockets.delete(sock);
        if (this.#sockets.size === 0) this.#linger();
      });
    });
  }

  get port(): number {
    return this.#port;
  }

  get #origin(): string {
    return `http://localhost:${this.#port}`;
  }

  /** The address that logs a tab in (its fragment is the login of this listener only). */
  get url(): string {
    return `${this.#origin}/#t=${loginCredential(this.#token, this.#port, this.#nonce)}`;
  }

  /** Listens on a port the system picks: outside the windows' range, and fresh for every open (origin-scoped storage). */
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', () => resolve());
    });
    this.#port = (this.#server.address() as AddressInfo).port;
    this.#linger();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#server.close();
    for (const s of this.#sockets) s.destroy();
    this.#wss.close();
    this.#o.onClose();
  }

  #linger(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.close(), this.#o.lingerMs ?? LINGER_MS);
    this.#timer.unref();
  }

  #hostOk(req: http.IncomingMessage): boolean {
    return req.headers.host?.toLowerCase() === `localhost:${this.#port}`;
  }

  #authed(req: http.IncomingMessage, needKey: boolean): boolean {
    return authenticated(req.headers, this.#token, this.#port, this.#nonce, needKey);
  }

  #request(req: http.IncomingMessage, res: http.ServerResponse, login: http.RequestListener): void {
    // only `localhost`: on 127.0.0.1 this page would share the cookies of this computer's windows
    if (!this.#hostOk(req)) return text(res, 403, 'forbidden host');
    const raw = req.url ?? '/';
    const qi = raw.indexOf('?');
    const path = qi === -1 ? raw : raw.slice(0, qi);
    const method = req.method ?? 'GET';
    const read = method === 'GET' || method === 'HEAD';
    if (!read && req.headers.origin !== this.#origin) return text(res, 403, 'forbidden origin');
    if (path === '/auth') return login(req, res);
    // answered here, never forwarded
    if (path === '/system/remote/page' || path === '/system/projects') {
      if (!read) return text(res, 405, 'method not allowed');
      if (!this.#authed(req, true)) return text(res, 401, 'unauthorized');
      if (path === '/system/remote/page') return json(res, this.#o.computer);
      return void this.#o.projects().then((l) => json(res, l), () => text(res, 500, 'internal error'));
    }
    if (path === '/system/remote/enter') return this.#enter(req, res, raw);
    // the rest of what a paired device may not reach (the other routes of the switcher, /os, /remote, /control)
    if (!goodPath(raw)) return text(res, 403, 'forbidden');
    // logged in here: the window's credentials go along (the channel's); not yet: only what the window serves anyone
    if (this.#authed(req, !cookieRoute(method, path))) return this.#forward(req, res, 'http', method, raw);
    if (!read) return text(res, 401, 'unauthorized');
    this.#forward(req, res, 'public', method, raw);
  }

  /**
   * The switcher's move from this page: a top-level navigation of this page's own (the cookie alone, as a navigation
   * carries no key), answered with a redirect to the target's login. `fetch` and XHR never see a redirect's fragment, and
   * Sec-Fetch-* (which page code cannot set) refuse anything but a navigation of this origin's own, so an iframe or a
   * request of page code gets nothing.
   */
  #enter(req: http.IncomingMessage, res: http.ServerResponse, raw: string): void {
    if (req.method !== 'GET') return text(res, 405, 'method not allowed');
    if (!this.#authed(req, false)) return text(res, 401, 'unauthorized');
    const h = req.headers;
    if (h['sec-fetch-site'] !== 'same-origin' || h['sec-fetch-mode'] !== 'navigate' || h['sec-fetch-dest'] !== 'document') return text(res, 403, 'forbidden');
    const q = new URL(raw, this.#origin).searchParams;
    const port = Number(q.get('port'));
    const host = q.get('host'), provider = q.get('provider'), root = q.get('root');
    const to: EnterTarget | null = !Number.isInteger(port) || port <= 0 ? null
      : host ? { host, port } : provider && root ? { provider, port, root } : null;
    if (!to) return text(res, 400, 'bad request');
    void this.#o.enter(to).then((r) => {
      if ('error' in r) return text(res, r.error === 'no such window' ? 404 : 409, r.error);
      res.writeHead(303, { location: r.url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end();
    }, () => text(res, 500, 'internal error'));
  }

  /** One request to the window over the channel; the body streams both ways at the stream's credit. */
  #forward(req: http.IncomingMessage, res: http.ServerResponse, kind: 'http' | 'public', method: string, path: string): void {
    // the other computer buffers a body whole, up to MAX_BODY: refused here before anything is sent (the page says why)
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) {
      res.setHeader('connection', 'close');
      return text(res, 413, 'request body too large');
    }
    const headers: Record<string, string> = {};
    for (const k of FORWARDED) {
      const v = req.headers[k];
      if (typeof v === 'string') headers[k] = v;
    }
    const s = this.#o.open({ kind, port: this.#o.port, method, path, headers });
    if (!s) return text(res, 502, 'the computer is not connected');
    s.on('head', (h: { status?: unknown; headers?: unknown }) => {
      if (res.headersSent) return;
      const out = h.headers && typeof h.headers === 'object' ? h.headers as Record<string, string> : {};
      res.writeHead(typeof h.status === 'number' ? h.status : 502, out);
    });
    s.ondata = (chunk) => {
      if (res.destroyed || res.write(chunk)) return;
      return new Promise<void>((r) => {
        res.once('drain', r);
        res.once('close', r);
      });
    };
    s.on('close', ({ code }: { code: number }) => {
      if (code === CLOSED && res.headersSent) return void res.end();
      if (!res.headersSent) return text(res, code === TOO_LARGE ? 413 : 502, code === TOO_LARGE ? 'request body too large' : 'the window could not be reached');
      res.destroy();
    });
    res.once('close', () => { if (!res.writableFinished) s.close(UNREACHABLE, 'the page went'); });
    req.on('data', (c: Buffer) => { if (!s.write(c)) req.pause(); });
    s.on('drain', () => req.resume());
    req.once('end', () => s.end());
  }

  #upgrade(req: http.IncomingMessage, sock: Socket, head: Buffer): void {
    const refuse = (status: string) => {
      sock.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    };
    const raw = req.url ?? '/';
    // a browser always sends its Origin with a socket: none, or another one, is not this page
    if (!this.#hostOk(req) || req.headers.origin !== this.#origin || !goodPath(raw) || !/^\/ws(\?|$)/.test(raw)) return refuse('403 Forbidden');
    if (!this.#authed(req, true)) return refuse('401 Unauthorized');
    this.#wss.handleUpgrade(req, sock, head, (ws) => this.#pipe(ws, raw));
  }

  /** The page's socket to the window's: every message as one, the window's close code back. */
  #pipe(ws: WebSocket, path: string): void {
    const s = this.#o.open({ kind: 'ws', port: this.#o.port, path });
    if (!s) return ws.close(4902, 'the computer is not connected');
    collect(s, (data, binary) => new Promise<void>((r) => ws.send(data, { binary }, () => r())));
    ws.on('message', (data: Buffer, binary: boolean) => { if (!s.write(data, binary)) ws.pause(); });
    s.on('drain', () => ws.resume());
    s.on('close', ({ code, reason }: { code: number; reason?: string }) => ws.close(sendable(code), reason?.slice(0, 120)));
    ws.on('close', () => s.close(CLOSED));
    ws.on('error', () => {});
  }
}
