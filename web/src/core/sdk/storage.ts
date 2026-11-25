// The storage of issue 511: one data-access interface for what outlives the page. `storage.local` is this origin's
// localStorage under the keys the app always used; `storage.pref` is a setting the server keeps for every window
// (prefs.json, /system/prefs), cached locally so a reload does not flash. A `hello` adopts its prefs in one place.
import { useSyncExternalStore } from 'react';
import { DEFAULT_THEME, isThemeId, isUiLang, isUiScale, type ThemeId, type UiLang, type UiScale } from '@nota-bene/shared';
import { connection, type HelloEvent } from './connections.ts';
import { pageVisible } from './repository.ts';
import { routes } from './routes.ts';
import { send as write } from './repository.ts';

/** How a value is kept as a string: `read` gives undefined for a string it does not know, `is` checks a server value. */
export interface Codec<T> {
  read(raw: string): T | undefined;
  write(v: T): string;
  is(v: unknown): v is T;
}

export const bool: Codec<boolean> = {
  read: (raw) => (raw === '1' ? true : raw === '0' ? false : undefined),
  write: (v) => (v ? '1' : '0'),
  is: (v): v is boolean => typeof v === 'boolean',
};
export const string: Codec<string> = { read: (raw) => raw, write: (v) => v, is: (v): v is string => typeof v === 'string' };
/** One of `values`, kept as its String (a number too: `1.25`). */
export const oneOf = <T extends string | number>(values: readonly T[]): Codec<T> => ({
  read: (raw) => values.find((v) => String(v) === raw),
  write: (v) => String(v),
  is: (v): v is T => (values as readonly unknown[]).includes(v),
});
/** JSON, checked by `valid` when given. */
export const json = <T = unknown>(valid: (v: unknown) => v is T = (_v): _v is T => true): Codec<T> => ({
  read: (raw) => {
    try {
      const v: unknown = JSON.parse(raw);
      return valid(v) ? v : undefined;
    } catch { return undefined; }
  },
  write: (v) => JSON.stringify(v),
  is: valid,
});

// --- local

export interface Stored<T> {
  get(): T;
  set(v: T): void;
  remove(): void;
  subscribe(fn: () => void): () => void;
}

// Reads go to the storage every time, so a value written elsewhere (another tab, a test) is what the next read sees; an
// item keeps its last decoded value with its string, so an unchanged string keeps its object (useSyncExternalStore).
// Per key: the listeners, and a value the storage refused (private mode, blocked, full): it holds for the page until a
// later write succeeds.
const memory = new Map<string, string | null>();
const listeners = new Map<string, Set<() => void>>();
const subscribers = new Map<string, (fn: () => void) => () => void>();

function rawOf(key: string): string | null {
  if (memory.has(key)) return memory.get(key)!;
  try { return localStorage.getItem(key); } catch { return null; }
}
function put(key: string, raw: string | null): void {
  try {
    if (raw === null) localStorage.removeItem(key);
    else localStorage.setItem(key, raw);
    memory.delete(key);
  } catch { memory.set(key, raw); /* storage unavailable or full: not persisted, held for the page */ }
  for (const fn of [...(listeners.get(key) ?? [])]) fn();
}
// another tab's write (issue 545): its key's listeners hear it at once, every key's on a clear (`key` null); its
// sessionStorage is not ours
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.storageArea !== localStorage) return;
    for (const [key, set] of listeners) if (e.key === null || e.key === key) for (const fn of [...set]) fn();
  });
}
/** one function per key, so a component's subscription does not change with the item it made */
function subscriberOf(key: string): (fn: () => void) => () => void {
  let sub = subscribers.get(key);
  if (!sub) {
    const set = new Set<() => void>();
    listeners.set(key, set);
    subscribers.set(key, (sub = (fn) => (set.add(fn), () => void set.delete(fn))));
  }
  return sub;
}
function decoder<T>(key: string, codec: Codec<T>): () => T | undefined {
  let last: { raw: string | null; v: T | undefined } | null = null;
  return () => {
    const raw = rawOf(key);
    if (last?.raw !== raw) last = { raw, v: raw === null ? undefined : codec.read(raw) };
    return last.v;
  };
}

/** `key` in this origin's storage, kept with `codec`; `fallback` when it holds nothing `codec` reads. */
function local<T>(key: string, codec: Codec<T>, fallback: T): Stored<T> {
  const peek = decoder(key, codec);
  return {
    get: () => peek() ?? fallback,
    set: (v) => { if (!Object.is(peek() ?? fallback, v)) put(key, codec.write(v)); },
    remove: () => put(key, null),
    subscribe: subscriberOf(key),
  };
}

/**
 * A stored value (or a pref) in a component: re-renders when it changes. Also the one reader of a value kept outside the
 * store on purpose (issue 545): what ticks with a media element (a player's clock), what non-React code must reach without
 * a store (toasts, the sources), the live objects of mounted views. `get` returns the same object while nothing changed.
 */
export function useStored<T>(item: { get(): T; subscribe(fn: () => void): () => void }): T {
  return useSyncExternalStore(item.subscribe, item.get);
}

// --- prefs

export type Sounds = { ask: boolean; done: boolean };
/**
 * The settings the server keeps for every window. `dictationLang` is not here: the server keeps it with the dictation
 * (`/dictation/lang`) and the controls slice holds it from the hello.
 */
export type SharedPrefs = { lang: UiLang; uiScale: UiScale; theme: ThemeId; projectRail: boolean | null; sounds: Sounds | null };

type Spec<T> = {
  /** the local cache's key; none: never cached, read from the server when asked */
  key?: string;
  codec: Codec<T>;
  fallback: T;
  /** `hello` carries it: an unconfirmed choice is sent again at the next hello */
  hello?: boolean;
  /** with none on the server, a choice this browser made before is moved up (`ifUnset`) */
  migrate?: boolean;
  /** what a server without the setting means, while nothing is cached */
  absent?: T;
};

const isSounds = (v: unknown): v is Sounds => !!v && typeof (v as Sounds).ask === 'boolean' && typeof (v as Sounds).done === 'boolean';
const nullable = <T>(c: Codec<T>): Codec<T | null> => c as Codec<T | null>;
const SPECS: { [K in keyof SharedPrefs]: Spec<SharedPrefs[K]> } = {
  lang: { key: 'lang', codec: { ...string, is: isUiLang, read: (r) => (isUiLang(r) ? r : undefined) } as Codec<UiLang>, fallback: 'en', hello: true, migrate: true },
  uiScale: { key: 'nb.uiScale', codec: { read: (r) => { const n = Number(r); return isUiScale(n) ? n : undefined; }, write: String, is: isUiScale }, fallback: 1, hello: true },
  theme: { key: 'nb.theme', codec: { ...string, is: isThemeId, read: (r) => (isThemeId(r) ? r : undefined) } as Codec<ThemeId>, fallback: DEFAULT_THEME, hello: true },
  projectRail: { key: 'nb.projectRail', codec: nullable(bool), fallback: null, absent: true },
  sounds: { codec: nullable(json(isSounds)), fallback: null },
};

export interface Pref<T> {
  get(): T;
  /**
   * The user's choice: here at once, and saved for every window. Saves go one at a time and the last one wins; a choice
   * overtaken before it went out is not sent. Resolves to why the save failed, or null.
   */
  set(v: T): Promise<string | null>;
  /** this page only: nothing is sent */
  here(v: T): void;
  /** the server's value wins over the cache, except while this page's own choice is unconfirmed */
  adopt(server: unknown): void;
  /** the server's value now (undefined: none, or it cannot be read) */
  read(): Promise<T | undefined>;
  /** a pref `hello` does not carry is read from the server for the first subscriber and whenever the page shows again */
  subscribe(fn: () => void): () => void;
  /** tests: re-read the cache, forget an unconfirmed choice and the saves in flight */
  reload(): void;
}

function makePref<K extends keyof SharedPrefs>(name: K): Pref<SharedPrefs[K]> {
  type T = SharedPrefs[K];
  const spec = SPECS[name] as Spec<T>;
  const cache = spec.key ? local(spec.key, spec.codec, spec.fallback) : null;
  const stored = spec.key ? decoder(spec.key, spec.codec) : () => undefined;
  const subs = new Set<() => void>();
  let cur = cache ? cache.get() : spec.fallback;
  /** the choice being saved: a read that may predate it must not undo it */
  let unsynced: { v: T } | null = null;
  let saves = 0;
  let busy = false;
  let queued: { v: T; done: (why: string | null) => void } | null = null;
  /** moves at reload, so a save still in flight from before does not touch the state after it */
  let epoch = 0;

  const here = (v: T) => {
    cache?.set(v);
    if (Object.is(v, cur)) return;
    cur = v;
    for (const f of [...subs]) f();
  };
  const post = async (body: object): Promise<string | null> => {
    try {
      const r = await write(routes.systemPrefs(), body, { keepalive: true });
      return r.ok ? null : String(r.status);
    } catch (e) { return e instanceof Error ? e.message : String(e); }
  };
  // the last choice's answer: confirmed, or (a pref hello does not bring back) the server's value is read again
  const settle = (n: number, why: string | null) => {
    if (n !== saves) return;
    if (why === null) unsynced = null;
    else if (!spec.hello) { unsynced = null; void refresh(); }
  };
  // one save at a time: a value that comes while one is out waits, and a newer one replaces it before it goes
  const enqueue = (v: T): Promise<string | null> => {
    if (!busy) return send(v);
    queued?.done(null);
    return new Promise((done) => { queued = { v, done }; });
  };
  const send = (v: T): Promise<string | null> => {
    busy = true;
    const at = epoch;
    const n = saves; // the choice this save carries: a newer one is not confirmed by it
    return post({ [name]: v }).then((why) => {
      if (at !== epoch) return why; // reloaded meanwhile (tests)
      busy = false;
      settle(n, why);
      const q = queued;
      queued = null;
      if (q) void send(q.v).then(q.done);
      return why;
    });
  };
  const read = async (): Promise<T | undefined> => {
    try {
      const r = await connection.fetch(routes.systemPrefs());
      const v: unknown = r.ok ? ((await r.json()) as Record<string, unknown>)[name] : undefined;
      return spec.codec.is(v) ? v : undefined;
    } catch { return undefined; }
  };
  const adopt = (server: unknown) => {
    if (unsynced) {
      if (spec.hello) void enqueue(unsynced.v);
      return;
    }
    if (spec.codec.is(server)) return here(server);
    if (spec.migrate) {
      const mine = stored();
      if (mine !== undefined) void post({ [name]: mine, ifUnset: true });
    } else if (cur === null && spec.absent !== undefined) here(spec.absent);
  };
  const refresh = async () => {
    if (unsynced) return;
    const v = await read();
    if (!unsynced) adopt(v);
  };
  const onShow = () => { if (pageVisible()) void refresh(); };

  return {
    get: () => cur,
    here,
    set: (v) => {
      here(v);
      unsynced = { v };
      saves++;
      return enqueue(v);
    },
    adopt,
    read,
    subscribe: (f) => {
      if (!spec.hello && spec.key && subs.size === 0) {
        void refresh();
        document.addEventListener('visibilitychange', onShow);
      }
      subs.add(f);
      return () => {
        subs.delete(f);
        if (!spec.hello && spec.key && subs.size === 0) document.removeEventListener('visibilitychange', onShow);
      };
    },
    reload: () => {
      cur = cache ? cache.get() : spec.fallback;
      unsynced = null;
      busy = false;
      queued = null;
      epoch++;
    },
  };
}

const prefs = new Map<keyof SharedPrefs, Pref<never>>();
function pref<K extends keyof SharedPrefs>(name: K): Pref<SharedPrefs[K]> {
  let p = prefs.get(name) as Pref<SharedPrefs[K]> | undefined;
  if (!p) prefs.set(name, (p = makePref(name)) as Pref<never>);
  return p;
}

/** The one adoption point of a connection's `hello`: the prefs it carries. */
export function adoptHello(ev: HelloEvent): void {
  pref('lang').adopt(ev.lang);
  pref('uiScale').adopt(ev.uiScale);
  pref('theme').adopt(ev.theme);
}

export const storage = { local, pref };
