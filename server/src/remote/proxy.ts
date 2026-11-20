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
import { isUiLang, type UiLang } from '@nota-bene/shared';
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
  /** the person's UI language (prefs.ts), for the page shown when the window cannot be reached */
  lang?: () => string | undefined;
};

/**
 * The page a navigation gets when the window cannot be reached (the computer is offline, or runs a Nota Bene without the
 * `public` stream): the app itself never loaded, so the words are here, in the UI's languages.
 */
const UNREACHABLE_PAGE: Record<UiLang, (name: string) => string> = {
  en: (n) => `${n} cannot be reached: it is offline, or its Nota Bene is older than this one. Reload when it is back.`,
  ru: (n) => `${n} недоступен: он не в сети или его Nota Bene старее этой. Обновите страницу, когда он вернётся.`,
  de: (n) => `${n} ist nicht erreichbar: offline, oder sein Nota Bene ist älter als dieses. Laden Sie neu, sobald er zurück ist.`,
  es: (n) => `No se puede acceder a ${n}: está desconectado o su Nota Bene es más antiguo que este. Recarga cuando vuelva.`,
  'pt-BR': (n) => `Não é possível acessar ${n}: está offline ou o Nota Bene dele é mais antigo que este. Recarregue quando voltar.`,
  'zh-CN': (n) => `无法连接 ${n}：它已离线，或其 Nota Bene 比这里的旧。恢复后请重新加载。`,
};
const escapeHtml = (v: string): string => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Why a failed switch came back (`/?enter=<code>`, web/src/projects/api.ts says it in words). */
const ENTER_CODES: Record<string, string> = { 'no such window': 'no-window', 'window not answering': 'not-answering', 'not connected': 'not-connected' };
/** Ports listeners had in this process: a new one takes another (a page's origin-scoped storage stays its own). */
const usedPorts = new Set<number>();

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

  /**
   * Listens on a port the system picks: outside the windows' range, and fresh for every open (origin-scoped storage); one
   * an earlier listener of this process had is passed over.
   */
  async start(): Promise<void> {
    const held: http.Server[] = [];
    try {
      for (let i = 0; ; i++) {
        await new Promise<void>((resolve, reject) => {
          this.#server.once('error', reject);
          this.#server.listen(0, '127.0.0.1', () => resolve());
        });
        const port = (this.#server.address() as AddressInfo).port;
        if (!usedPorts.has(port) || i >= 8) break;
        // keep it taken while another is asked for, so the system cannot hand it out again
        const hold = http.createServer();
        await new Promise<void>((r) => this.#server.close(() => r()));
        await new Promise<void>((r) => hold.listen(port, '127.0.0.1', () => r()).once('error', () => r()));
        held.push(hold);
      }
    } finally {
      for (const h of held) h.close();
    }
    this.#port = (this.#server.address() as AddressInfo).port;
    usedPorts.add(this.#port);
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
    // Nota Bene has no service worker: one a page registered would outlive this listener onto a later one on the port
    if (req.headers['service-worker'] !== undefined) return text(res, 403, 'forbidden');
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
    const h = req.headers;
    if (h['sec-fetch-site'] !== 'same-origin' || h['sec-fetch-mode'] !== 'navigate' || h['sec-fetch-dest'] !== 'document') return text(res, 403, 'forbidden');
    // a switch that cannot go comes back to this page, which says why (only a navigation of its own gets here)
    const back = (code: string) => {
      res.writeHead(303, { location: `/?enter=${code}`, 'cache-control': 'no-store' });
      res.end();
    };
    if (!this.#authed(req, false)) return back('login');
    const q = new URL(raw, this.#origin).searchParams;
    const port = Number(q.get('port'));
    const host = q.get('host'), provider = q.get('provider'), root = q.get('root');
    const to: EnterTarget | null = !Number.isInteger(port) || port <= 0 ? null
      : host ? { host, port } : provider && root ? { provider, port, root } : null;
    if (!to) return back('failed');
    void this.#o.enter(to).then((r) => {
      if ('error' in r) return back(ENTER_CODES[r.error] ?? 'failed');
      res.writeHead(303, { location: r.url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end();
    }, () => back('failed'));
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
    if (!s) return this.#unreachable(req, res, 'the computer is not connected');
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
      if (!res.headersSent) return code === TOO_LARGE ? text(res, 413, 'request body too large') : this.#unreachable(req, res, 'the window could not be reached');
      res.destroy();
    });
    res.once('close', () => { if (!res.writableFinished) s.close(UNREACHABLE, 'the page went'); });
    req.on('data', (c: Buffer) => { if (!s.write(c)) req.pause(); });
    s.on('drain', () => req.resume());
    req.once('end', () => s.end());
  }

  /** 502: a navigation gets a page in the person's language, anything else the short reason. */
  #unreachable(req: http.IncomingMessage, res: http.ServerResponse, why: string): void {
    if (req.headers['sec-fetch-dest'] !== 'document' || res.headersSent) return text(res, 502, why);
    const l = this.#o.lang?.();
    const lang: UiLang = isUiLang(l) ? l : 'en';
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html lang="${lang}"><meta charset="utf-8"><title>Nota Bene</title><p style="font:15px system-ui;margin:3em auto;max-width:36em">${escapeHtml(UNREACHABLE_PAGE[lang](this.#o.computer.name))}</p></html>`);
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
