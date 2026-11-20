// The project switcher's and the starter's client side: the server routes of server/src/projectRoutes.ts, their answer
// types (mirrored: the web does not import from server/), the polling hook, and the move of this tab to another window.
import { useEffect, useSyncExternalStore } from 'react';
import { t } from '@/i18n/index.ts';
import { apiFetch } from '@/net/auth.ts';
import { remotePage } from '@/net/local.ts';
import { toast } from '@/shell/toast.ts';

export type Provider = 'claude' | 'codex' | 'omp';
export type ProjectState = 'working' | 'waiting' | 'idle' | 'restarting' | 'silent';
export type LastMessage = { role: 'user' | 'assistant'; text: string; at?: number };
export type RunningRow = {
  provider: Provider; port: number; root: string; title: string | null; session: string | null; state: ProjectState; current: boolean; clients: number;
  /** final replies of its session the person has not seen (server/src/seen.ts) */
  unseen: number;
  last: LastMessage | null;
  /** issue 297: a window of a paired computer (its host id and name), opened through this computer's connector */
  remote?: { host: string; name: string };
};
export type RecentRow = { root: string; provider: Provider; at: number; running: boolean };
export type ProjectsList = { running: RunningRow[]; recent: RecentRow[]; /** folders removed from Recent: out of this window's history too */ hidden?: string[] };

export const PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude', codex: 'Codex', omp: 'omp' };

/** The move to another window: the login URL is used here and nowhere else. A seam for the tests (jsdom cannot navigate). */
export const nav = { go: (url: string): void => location.assign(url) };

/**
 * Calls `f` when Back (or Forward) brings this page from the back/forward cache, as it was when the tab left it for
 * another window (issue 449); returns the unsubscribe.
 */
export function onPageRestore(f: () => void): () => void {
  const h = (e: PageTransitionEvent) => { if (e.persisted) f(); };
  window.addEventListener('pageshow', h);
  return () => window.removeEventListener('pageshow', h);
}

let isOpen = false;
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };
/** The switcher's menu, open or closed from anywhere (Alt+P). */
export const projectsMenu = {
  open: () => { isOpen = true; emit(); },
  close: () => { isOpen = false; emit(); },
  toggle: () => { isOpen = !isOpen; emit(); },
  get: () => isOpen,
  subscribe: (f: () => void) => { subs.add(f); return () => void subs.delete(f); },
};

const isList = (v: unknown): v is ProjectsList =>
  !!v && typeof v === 'object' && Array.isArray((v as ProjectsList).running) && Array.isArray((v as ProjectsList).recent);

// GET /system/projects, one fetch loop for the page however many parts show it (the header's switcher, the rail): every
// 3 s while any of them is `active` (the menu is open, the rail shows) and the window has the focus, every 10 s otherwise;
// never while the page is hidden. A request that does not answer in 8 s is given up. The last part gone stops it and
// drops the list.
let list: ProjectsList | null = null;
const listSubs = new Set<() => void>();
const demand = new Map<symbol, boolean>();
let period = 0;
let timer: ReturnType<typeof setInterval> | undefined;
/** the request on its way (its start), or null: one at a time, and one older than a period no longer holds the next back */
let inFlight: { at: number; id: number } | null = null;
let reqs = 0;
let gen = 0;
const TIMEOUT_MS = 8000;

const timeoutSignal = (): AbortSignal | undefined => (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined);

function load(): void {
  if (document.visibilityState === 'hidden') return;
  if (inFlight && Date.now() - inFlight.at < (period || TIMEOUT_MS)) return;
  const me = { at: Date.now(), id: ++reqs };
  inFlight = me;
  const g = gen;
  const signal = timeoutSignal();
  apiFetch('/system/projects', signal ? { signal } : undefined)
    .then((r) => (r.ok ? r.json() : undefined))
    .then((j: unknown) => {
      if (g !== gen || inFlight !== me) return;
      // a refusal keeps the last list; a malformed answer is an empty one
      if (j === undefined) { if (list) return; list = { running: [], recent: [] }; } else list = isList(j) ? j : { running: [], recent: [] };
      for (const f of listSubs) f();
    })
    .catch(() => { /* the next poll tries again; the header's own line says when the server is gone */ })
    .finally(() => { if (inFlight === me) inFlight = null; });
}

const focused = () => typeof document.hasFocus !== 'function' || document.hasFocus();

function schedule(): void {
  const want = demand.size === 0 ? 0 : [...demand.values()].some(Boolean) && focused() ? 3000 : 10_000;
  if (want === period) return;
  const wasSlow = period === 10_000;
  clearInterval(timer);
  timer = undefined;
  period = want;
  if (want) timer = setInterval(load, want);
  if (want === 3000 && wasSlow) load();
}

const onFocusChange = () => schedule();
// issue 449: Back to a page this tab left for another window brings it from the back/forward cache with the list it had then.
// Whether it is visible yet at pageshow depends on the browser: a hidden one loads when it shows.
let restored = false;
const onPageShow = (e: PageTransitionEvent) => {
  if (!e.persisted) return;
  inFlight = null;
  if (document.visibilityState === 'hidden') restored = true;
  else load();
};
const onVisible = () => {
  if (!restored || document.visibilityState === 'hidden') return;
  restored = false;
  inFlight = null;
  load();
};
let listening = false;
function listen(on: boolean): void {
  if (on === listening) return;
  listening = on;
  const f = on ? window.addEventListener : window.removeEventListener;
  f.call(window, 'focus', onFocusChange);
  f.call(window, 'blur', onFocusChange);
  f.call(window, 'pageshow', onPageShow as EventListener);
  (on ? document.addEventListener : document.removeEventListener).call(document, 'visibilitychange', onVisible);
  if (!on) restored = false;
}

/** Nobody shows the list any more (checked after the commit: a part re-subscribing for another `active` keeps it). */
function dropIfUnused(): void {
  if (demand.size > 0) return;
  listen(false);
  gen++;
  inFlight = null;
  list = null;
}

const subscribeList = (f: () => void) => { listSubs.add(f); return () => void listSubs.delete(f); };
const getList = () => list;

/** The projects list, shared: `active` asks for the 3 s poll while it holds; a change of it loads at once. */
export function useProjects(active: boolean): { data: ProjectsList | null; reload(): void } {
  const data = useSyncExternalStore(subscribeList, getList);
  useEffect(() => {
    const id = Symbol('projects');
    demand.set(id, active);
    listen(true);
    schedule();
    load();
    return () => { demand.delete(id); schedule(); void Promise.resolve().then(dropIfUnused); };
  }, [active]);
  return { data, reload: () => { inFlight = null; load(); } };
}

export const postJson = (url: string, body: unknown): Promise<Response> =>
  apiFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** The server's fixed refusals (server/src/projects.ts, projectRoutes.ts), in the page's language; any other text (a launcher's line) as it is. */
const REASONS = {
  'no such window': 'whyNoWindow', 'window not answering': 'whyNotAnswering', 'not a folder': 'whyNotFolder', 'not readable': 'whyNotReadable',
  'not writable': 'whyNotWritable', 'git init failed': 'whyGitInit', 'bad request': 'whyBadRequest', 'bad answer': 'whyBadRequest',
  'still starting': 'startStill', exists: 'startExists', refused: 'whyRefused',
} as const;
export const reasonText = (why: string): string => (why in REASONS ? t(REASONS[why as keyof typeof REASONS]) : why);

/** A failed answer's reason: the server's short text, or the status. */
export const reasonOf = async (r: Response): Promise<string> => (await r.text().catch(() => '')).trim() || String(r.status);

/** Removes a folder from Recent (POST /system/projects/forget): null, or the reason it failed. */
export async function forgetRecent(root: string): Promise<string | null> {
  try {
    const r = await postJson('/system/projects/forget', { root });
    return r.ok ? null : reasonOf(r);
  } catch {
    return 'window not answering';
  }
}

/**
 * Moves this tab to the window of `row`, logged in (that window opens `session` when given); a refusal is a toast and the tab
 * stays (false). Another computer's window opens through this computer's connector (POST /system/remote/open). From such a
 * window's page (issue 297) the move is a navigation to its proxy's `/system/remote/enter`, whose redirect carries the
 * login: page code there never holds a credential of this computer's windows.
 */
export async function enterProject(row: RunningRow, session?: string): Promise<boolean> {
  if (remotePage()) {
    const q = new URLSearchParams(row.remote ? { host: row.remote.host, port: String(row.port) } : { provider: row.provider, port: String(row.port), root: row.root });
    nav.go(`/system/remote/enter?${q}`);
    return true;
  }
  try {
    const r = row.remote
      ? await postJson('/system/remote/open', { host: row.remote.host, port: row.port })
      : await postJson('/system/projects/enter', { provider: row.provider, port: row.port, root: row.root, ...(session ? { session } : {}) });
    // the remote routes say why as JSON `{error}`, the switcher's as text
    if (!r.ok) {
      const why = row.remote ? ((await r.json().catch(() => null)) as { error?: unknown } | null)?.error : await reasonOf(r);
      toast(t('projEnterFailed', reasonText(typeof why === 'string' ? why : String(r.status))), row.root);
      return false;
    }
    const { url } = (await r.json()) as { url?: unknown };
    if (typeof url !== 'string') { toast(t('projEnterFailed', reasonText('bad answer')), row.root); return false; }
    nav.go(url);
    return true;
  } catch (e) {
    toast(t('projEnterFailed', e instanceof Error ? e.message : String(e)), row.root);
    return false;
  }
}

/** Stops that window from the list (its agent and launcher; the session stays); the refusal's reason, or null. */
export async function stopProject(row: RunningRow): Promise<string | null> {
  try {
    const r = await postJson('/system/projects/stop', { provider: row.provider, port: row.port, root: row.root });
    return r.ok ? null : await reasonOf(r);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The header's Stop Nota Bene, before this window stops itself: every other window; how many could not be stopped. */
export async function stopOthers(): Promise<number> {
  try {
    const r = await postJson('/system/projects/stop-others', {});
    if (!r.ok) return -1;
    const j = (await r.json()) as { failed?: unknown };
    return typeof j.failed === 'number' ? j.failed : -1;
  } catch {
    return -1;
  }
}

/** The starter's open handle (Starter.tsx mounts the dialog and listens). */
let starter: ((mode: 'open' | 'new') => void) | null = null;
export const setStarter = (f: ((mode: 'open' | 'new') => void) | null): void => { starter = f; };
export const openStarter = (mode: 'open' | 'new'): void => starter?.(mode);

/**
 * Opens `dir` in a window of `provider` (started if none) and moves this tab there, to `session` when given (landing.ts);
 * resolves to the refusal's reason, or null.
 */
export async function openFolder(dir: string, provider: Provider, create?: { name: string; git: boolean }, session?: string): Promise<string | null> {
  try {
    const r = create
      ? await postJson('/system/projects/create', { parent: dir, name: create.name, git: create.git, provider })
      : await postJson('/system/projects/open', { dir, provider });
    if (!r.ok) return reasonOf(r);
    const { url } = (await r.json()) as { url?: unknown };
    if (typeof url !== 'string') return 'bad answer';
    nav.go(session ? `${url}&s=${session}` : url);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The folder names the server's create accepts (server/src/projectRoutes.ts validName): one segment, nothing Windows refuses. */
export const validName = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..' && !/[/\\:*?"<>|\x00-\x1f]/.test(name)
  && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) && !name.endsWith('.')
  && name.trim() === name && new TextEncoder().encode(name).length <= 255;

export const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
