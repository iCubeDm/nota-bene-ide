import { agentOf, agentPath, type ClientMessage, type ServerEvent } from '@nota-bene/shared';

const RECONNECT_MS = 1000;

// unauthorized = the server refused the page's login (no cookie): reopen the window through `nota-bene` or `/nb`; no retries
export type SocketState = 'open' | 'closed' | 'unauthorized';
export type Connection = { send(m: ClientMessage): boolean; close(): void };

/** The page's agent (epic 383): `/a/<id>` when the page was opened under one, else '' (the window's top, today's URLs). */
export function agentBase(loc: Location | URL): string {
  const id = agentOf(loc.pathname);
  return id ? agentPath(id) : '';
}

export function defaultSocketUrl(loc: Location | URL): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${agentBase(loc)}/ws`;
}

/**
 * `url` may be a function: read at every (re)connect, so a retry can carry what changed since (`&passive=1`).
 * `refused` (optional) tells a socket the server turned away for lack of a login from one that failed for any other reason (a
 * browser shows both as a plain close): asked when a socket closed before its first frame. True stops the retries.
 * `protocols` carries the page's key (the `nb.<key>` subprotocol: never in the URL).
 */
export function connect(
  url: string | (() => string),
  onEvent: (ev: ServerEvent) => void,
  onState: (s: SocketState) => void,
  WS: typeof WebSocket = WebSocket,
  refused?: () => Promise<boolean>,
  protocols?: () => string[],
): Required<Connection> {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let reportedClosed = true; // no 'closed' until we have been open

  const open = () => {
    timer = null;
    const sock = new WS(typeof url === 'function' ? url() : url, protocols?.() ?? []);
    ws = sock;
    let gotFrame = false;
    // not `open` on the WebSocket's open: a socket is attached only when the server's replay arrives (a server before 39
    // sends none to an occupied socket), and before it must neither resync nor send (M7-15 fix round 1)
    sock.onopen = () => {};
    sock.onmessage = (e) => {
      gotFrame = true;
      let ev: ServerEvent;
      try {
        ev = JSON.parse(String(e.data)) as ServerEvent;
      } catch (err) {
        console.warn('socket: dropped unparseable frame', err);
        return;
      }
      if (ev.kind === 'replay' && ws === sock && reportedClosed) {
        reportedClosed = false;
        onState('open');
      }
      onEvent(ev);
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (!reportedClosed) {
        reportedClosed = true;
        onState('closed');
      }
      if (stopped || timer) return;
      const retry = () => {
        if (!stopped && !timer) timer = setTimeout(open, RECONNECT_MS);
      };
      if (gotFrame || !refused) return retry();
      void refused().then((no) => {
        if (stopped) return;
        if (!no) return retry();
        stopped = true;
        onState('unauthorized');
      }, retry);
    };
  };
  open();

  // a page put into the back/forward cache (a navigation to another URL, e.g. adding `?nudge`) keeps its socket open, a
  // client of a page nobody sees. So close on the way in; a restored page reconnects as on a drop
  const onHide = (e: PageTransitionEvent) => {
    if (!e.persisted || stopped) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const sock = ws;
    ws = null;
    if (sock) sock.onclose = null;
    sock?.close();
    hidden = true;
  };
  const onShow = (e: PageTransitionEvent) => {
    if (!e.persisted || !hidden) return;
    hidden = false;
    if (!reportedClosed) {
      reportedClosed = true;
      onState('closed');
    }
    if (!stopped) open();
  };
  let hidden = false;
  const win = typeof window === 'undefined' ? null : window;
  win?.addEventListener('pagehide', onHide);
  win?.addEventListener('pageshow', onShow);

  return {
    send(m) {
      if (!ws || ws.readyState !== WS.OPEN || reportedClosed) return false; // not attached yet: nothing goes out before the replay
      ws.send(JSON.stringify(m));
      return true;
    },
    close() {
      stopped = true;
      win?.removeEventListener('pagehide', onHide);
      win?.removeEventListener('pageshow', onShow);
      if (timer) clearTimeout(timer);
      timer = null;
      ws?.close();
    },
  };
}
