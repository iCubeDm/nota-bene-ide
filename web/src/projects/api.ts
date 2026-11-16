// The project switcher's and the starter's client side: the server routes of server/src/projectRoutes.ts, their answer
// types (mirrored: the web does not import from server/), the polling hook, and the move of this tab to another window.
import { useEffect, useSyncExternalStore } from 'react';
import { t } from '@/i18n/index.ts';
import { apiFetch } from '@/net/auth.ts';
import { toast } from '@/shell/toast.ts';

export type Provider = 'claude' | 'codex' | 'omp';
export type ProjectState = 'working' | 'waiting' | 'idle' | 'restarting' | 'silent';
export type LastMessage = { role: 'user' | 'assistant'; text: string; at?: number };
export type RunningRow = {
  provider: Provider; port: number; root: string; title: string | null; session: string | null; state: ProjectState; current: boolean; clients: number;
  /** final replies of its session the person has not seen (server/src/seen.ts) */
  unseen: number;
  last: LastMessage | null;
};
export type RecentRow = { root: string; provider: Provider; at: number; running: boolean };
export type ProjectsList = { running: RunningRow[]; recent: RecentRow[]; /** folders removed from Recent: out of this window's history too */ hidden?: string[] };

export const PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude', codex: 'Codex', omp: 'omp' };

/** The move to another window: the login URL is used here and nowhere else. A seam for the tests (jsdom cannot navigate). */
export const nav = { go: (url: string): void => location.assign(url) };

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
// 3 s while any of them is `active` (the menu is open, the rail shows), every 10 s otherwise; only while the page is
// visible. The last one gone stops it and drops the list.
let list: ProjectsList | null = null;
const listSubs = new Set<() => void>();
const demand = new Map<symbol, boolean>();
let period = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
let gen = 0;

function load(): void {
  if (inFlight || document.visibilityState === 'hidden') return;
  inFlight = true;
  const g = gen;
  apiFetch('/system/projects')
    .then((r) => (r.ok ? r.json() : null))
    .then((j: unknown) => {
      if (g !== gen) return;
      list = isList(j) ? j : { running: [], recent: [] };
      for (const f of listSubs) f();
    })
    .catch(() => { /* the next poll tries again; the header's own line says when the server is gone */ })
    .finally(() => { if (g === gen) inFlight = false; });
}

function schedule(): void {
  const want = demand.size === 0 ? 0 : [...demand.values()].some(Boolean) ? 3000 : 10_000;
  if (want === period) return;
  clearInterval(timer);
  timer = undefined;
  period = want;
  if (want) timer = setInterval(load, want);
}

/** Nobody shows the list any more (checked after the commit: a part re-subscribing for another `active` keeps it). */
function dropIfUnused(): void {
  if (demand.size > 0) return;
  gen++;
  inFlight = false;
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
    schedule();
    load();
    return () => { demand.delete(id); schedule(); queueMicrotask(dropIfUnused); };
  }, [active]);
  return { data, reload: () => { inFlight = false; gen++; load(); } };
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

/** Moves this tab to the window of `row`, logged in (that window opens `session` when given); a refusal is a toast and the tab stays. */
export async function enterProject(row: RunningRow, session?: string): Promise<void> {
  try {
    const r = await postJson('/system/projects/enter', { provider: row.provider, port: row.port, root: row.root, ...(session ? { session } : {}) });
    if (!r.ok) return toast(t('projEnterFailed', reasonText(await reasonOf(r))), row.root);
    const { url } = (await r.json()) as { url?: unknown };
    if (typeof url !== 'string') return toast(t('projEnterFailed', reasonText('bad answer')), row.root);
    nav.go(url);
  } catch (e) {
    toast(t('projEnterFailed', e instanceof Error ? e.message : String(e)), row.root);
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
