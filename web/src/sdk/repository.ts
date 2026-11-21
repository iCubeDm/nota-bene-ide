// Server data fetched over HTTP (issue 511): one shared mechanism instead of a poll loop per component. Per connection,
// one cache entry per resource and key; its watchers share one request in flight and one timer (the shortest period
// any of them asks for). The poll pauses while the page is hidden and while the connection is down; showing the page
// reads what the pause missed, a reconnect reads everything watched. A failure (a refusal, a network error, the
// timeout) marks the entry failed and keeps its data; an answer with the same text keeps the same object, so a large
// diff does not re-render. The page's visibility is read here and nowhere else.
import { useCallback, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { ReactReduxContext } from 'react-redux';
import type { ServerEvent } from '@nota-bene/shared';
import { connections, connectionsOf, type AgentConnection, type ConnectionManager, type ConnState, type Route } from './connections.ts';

export interface Resource<A, T> {
  /** its name in the registry (`Plugin.resources`), where a test answers it by name */
  id?: string;
  key(args: A): string;
  route(args: A): Route;
  /** ms between reads while watched (a watcher may ask for another period); none: read on watch, refresh and events */
  every?: number;
  /** server events after which it is read again */
  events?: ServerEvent['kind'][];
  /** the answer's text into data (JSON by default); a throw is a failure */
  parse?: (text: string) => T;
  /** a request is given up after this long, or at the next tick if that comes first */
  timeout?: number;
}

export const defineResource = <A, T>(r: Resource<A, T>): Resource<A, T> => r;

export interface Snapshot<T> {
  readonly data: T | null;
  /** the last read failed (what came before stays in `data`) */
  readonly failed: boolean;
  /** why: `<path> <status>`, `timeout` or the network error's message */
  readonly error: string | null;
  /** a read is on its way and nothing has come yet */
  readonly loading: boolean;
  /** the HTTP status of a refusal (undefined after an answer, a timeout or a network error) */
  readonly status?: number;
}

export interface WatchOptions {
  /** ms between reads for this watcher (default: the resource's `every`; 0 is none) */
  every?: number;
  /** keep polling while the page is hidden (a server-side process that must be followed to its end) */
  whileHidden?: boolean;
}

export interface Repository {
  /** reads now, replacing a request in flight (deferred while paused) */
  load<A, T>(res: Resource<A, T>, args: A): Promise<T | null>;
  /** keeps it fresh until the returned stop; the first watcher reads at once (a new request), and so does a shorter period when the last read is older than it */
  watch<A, T>(res: Resource<A, T>, args: A, o?: WatchOptions): Stop;
  peek<A, T>(res: Resource<A, T>, args: A): Snapshot<T>;
  subscribe<A, T>(res: Resource<A, T>, args: A, fn: () => void): () => void;
  /** forgets the answer (of one key, or every key of the resource); a watched entry reads again */
  invalidate<A, T>(res: Resource<A, T>, args?: A): void;
}

/** ends a watch; `set` changes what this watcher asks for */
export type Stop = (() => void) & { set(o: WatchOptions): void };

const INITIAL: Snapshot<never> = Object.freeze({ data: null, failed: false, error: null, loading: false });
/** the states in which the poll waits: `connecting` (never open yet) does not, so a page's first reads go out at once */
const DOWN = new Set<ConnState>(['closed', 'occupied', 'taken', 'unauthorized', 'stopped']);
/** unwatched entries kept for a later watcher; older ones are dropped */
const KEEP = 32;

/** Whether the person can see the page (a background tab or a minimised window cannot). */
export const pageVisible = (): boolean => document.visibilityState === 'visible';
const pageHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

type Entry = {
  res: Resource<unknown, unknown>;
  args: unknown;
  snap: Snapshot<unknown>;
  /** the text the data was parsed from */
  text: string | null;
  watchers: Map<symbol, { every: number; whileHidden: boolean }>;
  every: number;
  timer?: ReturnType<typeof setInterval>;
  /** the latest request on its way; an older one replaced by it may still answer, until a newer answer lands */
  req: { ctl: AbortController; at: number; n: number; done: Promise<void> } | null;
  /** requests made, and the number of the one whose answer is shown */
  made: number;
  shown: number;
  /** when the latest request started */
  at: number;
  /** a read was due while paused */
  due: boolean;
  subs: Set<() => void>;
};

const repos = new WeakMap<AgentConnection, Repository>();

/** The repository of one connection (made on first use). */
export function repositoryOf(conn: AgentConnection): Repository {
  let repo = repos.get(conn);
  if (!repo) repos.set(conn, (repo = makeRepository(conn)));
  return repo;
}

function makeRepository(conn: AgentConnection): Repository {
  const byRes = new Map<Resource<unknown, unknown>, Map<string, Entry>>();
  const live = (e: Entry) => e.watchers.size > 0;
  const all = function* () { for (const m of byRes.values()) yield* m.values(); };
  const paused = (e: Entry) => (pageHidden() && ![...e.watchers.values()].some((w) => w.whileHidden)) || DOWN.has(conn.state());

  const entry = <A, T>(res: Resource<A, T>, args: A): Entry => {
    const r = res as Resource<unknown, unknown>;
    let m = byRes.get(r);
    if (!m) byRes.set(r, (m = new Map()));
    const key = res.key(args);
    let e = m.get(key);
    if (!e) m.set(key, (e = { res: r, args, snap: INITIAL, text: null, watchers: new Map(), every: 0, req: null, made: 0, shown: 0, at: 0, due: false, subs: new Set() }));
    return e;
  };
  const set = (e: Entry, next: Partial<Snapshot<unknown>>) => {
    e.snap = { ...e.snap, ...next };
    for (const fn of [...e.subs]) fn();
  };

  const read = (e: Entry, force: boolean): Promise<void> => {
    if (paused(e)) {
      e.due = true;
      return e.req?.done ?? Promise.resolve();
    }
    if (e.req && !force) return e.req.done;
    e.due = false;
    const ctl = new AbortController();
    const route = e.res.route(e.args);
    const req: NonNullable<Entry['req']> = { ctl, at: (e.at = Date.now()), n: ++e.made, done: Promise.resolve() };
    e.req = req;
    if (e.snap.data === null && !e.snap.loading) set(e, { loading: true });
    const timer = e.res.timeout ? setTimeout(() => ctl.abort(), e.res.timeout) : undefined;
    req.done = (async () => {
      try {
        // an abort settles the read even if the fetch it went to ignores the signal
        const r = await Promise.race([conn.fetch(route, { signal: ctl.signal }), new Promise<never>((_, no) => ctl.signal.addEventListener('abort', () => no(new Error('aborted'))))]);
        const text = await r.text();
        if (req.n < e.shown) return;
        if (!r.ok) return e.req === req ? set(e, { failed: true, error: `${route.replace(/\?.*$/, '')} ${r.status}`, status: r.status, loading: false }) : undefined;
        e.shown = req.n;
        if (e.text !== null && text === e.text) {
          if (e.snap.failed || e.snap.loading) set(e, { failed: false, error: null, status: undefined, loading: false });
          return;
        }
        const data = e.res.parse ? e.res.parse(text) : JSON.parse(text);
        e.text = text;
        set(e, { data, failed: false, error: null, status: undefined, loading: false });
      } catch (err) {
        if (e.req !== req) return;
        e.shown = req.n;
        set(e, { failed: true, error: ctl.signal.aborted ? 'timeout' : err instanceof Error ? err.message : String(err), status: undefined, loading: false });
      } finally {
        clearTimeout(timer);
        if (e.req === req) e.req = null;
      }
    })();
    return req.done;
  };

  // with a timeout, an answer is not worth more than the next one: a tick replaces a request older than the period
  const tick = (e: Entry) => void read(e, !!e.res.timeout && !!e.req && Date.now() - e.req.at >= e.every);
  /** The shortest period asked for; the timer restarts when it changes. */
  const retime = (e: Entry) => {
    const every = Math.min(...[...e.watchers.values()].map((w) => w.every).filter((n) => n > 0), Infinity);
    const next = every === Infinity ? 0 : every;
    if (next === e.every) return;
    clearInterval(e.timer);
    e.timer = next ? setInterval(() => tick(e), next) : undefined;
    e.every = next;
  };

  // one visibility listener, one connection-state subscription and one event listener while anything is watched
  let down = DOWN.has(conn.state());
  const onVisible = () => {
    for (const e of all()) if (live(e) && e.due && !paused(e)) void read(e, false);
  };
  const onState = () => {
    const was = down;
    down = DOWN.has(conn.state());
    // forced: a request hung across the drop is not waited for
    if (was && !down) for (const e of all()) if (live(e)) void read(e, true);
  };
  const onEvent = (ev: ServerEvent) => {
    for (const e of all()) if (live(e) && e.res.events?.includes(ev.kind)) void read(e, true);
  };
  let watched = 0;
  let off: (() => void) | null = null;
  const listen = () => {
    if (watched > 0 && !off) {
      down = DOWN.has(conn.state());
      document.addEventListener('visibilitychange', onVisible);
      const unState = conn.subscribe(onState);
      const unEvent = conn.onEvent(onEvent);
      off = () => { document.removeEventListener('visibilitychange', onVisible); unState(); unEvent(); };
    } else if (watched === 0 && off) {
      off();
      off = null;
    }
  };

  /** Drops the oldest entries nobody watches or reads beyond KEEP. */
  const sweep = () => {
    const idle = [...byRes.entries()].flatMap(([r, m]) => [...m.entries()].filter(([, e]) => !live(e) && e.subs.size === 0).map(([k]) => [r, k] as const));
    for (const [r, k] of idle.slice(0, Math.max(0, idle.length - KEEP))) byRes.get(r)!.delete(k);
  };

  return {
    load: (res, args) => {
      const e = entry(res, args);
      return read(e, true).then(() => e.snap.data as never);
    },
    watch: (res, args, o = {}) => {
      const e = entry(res, args);
      const id = Symbol('watch');
      if (!live(e)) {
        watched++;
        listen();
      }
      const set = (w: WatchOptions, first: boolean) => {
        const before = e.every;
        e.watchers.set(id, { every: w.every ?? res.every ?? 0, whileHidden: !!w.whileHidden });
        retime(e);
        // a first watcher asks afresh; a shorter period catches up when the last ask is older than it
        const behind = e.every > 0 && (before === 0 || e.every < before) && Date.now() - e.at >= e.every;
        if (first || behind || (e.due && !paused(e))) void read(e, first);
      };
      set(o, e.watchers.size === 0);
      const stop = () => {
        if (!e.watchers.delete(id)) return;
        retime(e);
        if (live(e)) return;
        // the newest at the end: the sweep drops the oldest first
        const m = byRes.get(e.res)!;
        const key = e.res.key(e.args);
        m.delete(key);
        m.set(key, e);
        watched--;
        listen();
        sweep();
      };
      return Object.assign(stop, { set: (w: WatchOptions) => { if (e.watchers.has(id)) set(w, false); } });
    },
    peek: (res, args) => (byRes.get(res as Resource<unknown, unknown>)?.get(res.key(args))?.snap ?? INITIAL) as Snapshot<never>,
    subscribe: (res, args, fn) => {
      const e = entry(res, args);
      e.subs.add(fn);
      return () => {
        e.subs.delete(fn);
        if (e.subs.size === 0) sweep();
      };
    },
    invalidate: (res, args) => {
      const m = byRes.get(res as Resource<unknown, unknown>);
      if (!m) return;
      for (const e of args === undefined ? [...m.values()] : [m.get(res.key(args))].filter((x) => x !== undefined)) {
        e.req?.ctl.abort();
        e.req = null;
        e.shown = e.made;
        e.text = null;
        set(e, INITIAL);
        if (live(e)) void read(e, false);
      }
    },
  };
}

/** The current connection's repository, for code outside React. */
export const repository: Repository = {
  load: (res, args) => repositoryOf(connections.current()).load(res, args),
  watch: (res, args, o) => repositoryOf(connections.current()).watch(res, args, o),
  peek: (res, args) => repositoryOf(connections.current()).peek(res, args),
  subscribe: (res, args, fn) => repositoryOf(connections.current()).subscribe(res, args, fn),
  invalidate: (res, args) => repositoryOf(connections.current()).invalidate(res, args),
};

/** The connection of the store in context; outside a store's Provider, the page's current one. */
function useAgent(): AgentConnection {
  const store = useContext(ReactReduxContext)?.store;
  return (store && (connectionsOf(store) as ConnectionManager | undefined)?.current()) || connections.current();
}

const noop = () => () => {};

/**
 * A resource for `args` (null: nothing asked), watched while `on` (default true), at the resource's period or `every`
 * (which may depend on what is shown: a phase that is still moving is polled, a settled one is not; 0 is no poll), and
 * `whileHidden` keeps it polled while the page is hidden.
 * A new `refreshOn` value reads again at once (a turn, a disk change); `refresh` does the same.
 */
export function useResource<A, T>(res: Resource<A, T>, args: A | null, o: { on?: boolean; every?: number | ((now: Snapshot<T>) => number); whileHidden?: boolean; refreshOn?: unknown } = {}): Snapshot<T> & { refresh(): void } {
  const repo = repositoryOf(useAgent());
  const key = args === null ? null : res.key(args);
  const at = useRef(args);
  at.current = args;
  const on = o.on ?? true;
  const subscribe = useCallback((fn: () => void) => (at.current === null ? noop() : repo.subscribe(res, at.current, fn)), [repo, res, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const snap = useSyncExternalStore(subscribe, () => (at.current === null ? INITIAL : repo.peek(res, at.current))) as Snapshot<T>;
  const ms = typeof o.every === 'function' ? o.every(snap) : o.every;
  const hiddenToo = !!o.whileHidden;
  const want = useRef<WatchOptions>({});
  want.current = { every: ms, whileHidden: hiddenToo };
  const watch = useRef<Stop | null>(null);
  useEffect(() => {
    if (at.current === null || !on) return;
    const stop = (watch.current = repo.watch(res, at.current, want.current));
    return () => { stop(); watch.current = null; };
  }, [repo, res, key, on]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => watch.current?.set({ every: ms, whileHidden: hiddenToo }), [ms, hiddenToo]);
  const seen = useRef(o.refreshOn);
  useEffect(() => {
    if (Object.is(seen.current, o.refreshOn)) return;
    seen.current = o.refreshOn;
    if (at.current !== null && on) void repo.load(res, at.current);
  }, [o.refreshOn]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = useCallback(() => { if (at.current !== null) void repo.load(res, at.current); }, [repo, res]);
  return { ...snap, refresh };
}
