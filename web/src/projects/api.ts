// The project switcher's and the starter's client side: the server routes of server/src/projectRoutes.ts, their answer
// types (mirrored: the web does not import from server/), the polled list, and the move of this tab to another window.
import { useEffect, useRef, useState } from 'react';
import { t, connections, defineResource, routes, toast, useResource, remotePage } from '@/sdk';

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
type RecentRow = { root: string; provider: Provider; at: number; running: boolean };
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

const EMPTY: ProjectsList = { running: [], recent: [] };
// GET /system/projects, one poll for the page however many parts show it (the header's switcher, the rail): every 3 s
// while any of them is `active` (the menu is open, the rail shows) and the window has the focus, every 10 s otherwise;
// never while the page is hidden. A request that does not answer in 8 s, or by the next poll, is given up.
export const projectsResource = defineResource<void, ProjectsList>({
  id: 'projects.list',
  key: () => '',
  route: () => routes.systemProjects(),
  timeout: 8000,
  // a malformed answer is an empty list
  parse: (text) => { const j: unknown = JSON.parse(text); return isList(j) ? j : EMPTY; },
});

const hasFocus = () => typeof document.hasFocus !== 'function' || document.hasFocus();

/** The projects list, shared: `active` asks for the 3 s poll while it holds; a change of it loads at once. */
export function useProjects(active: boolean): { data: ProjectsList | null; reload(): void } {
  const [focused, setFocused] = useState(hasFocus);
  useEffect(() => {
    const f = () => setFocused(hasFocus());
    window.addEventListener('focus', f);
    window.addEventListener('blur', f);
    return () => { window.removeEventListener('focus', f); window.removeEventListener('blur', f); };
  }, []);
  const { data, failed, refresh } = useResource(projectsResource, undefined, { every: active && focused ? 3000 : 10_000 });
  const was = useRef(active);
  useEffect(() => {
    if (was.current === active) return;
    was.current = active;
    refresh();
  }, [active, refresh]);
  // issue 449: Back to a page this tab left for another window brings it from the back/forward cache with the list it
  // had then; a page restored hidden reads once it shows (the repository's pause)
  useEffect(() => onPageRestore(refresh), [refresh]);
  // a refusal keeps the last list; with none yet it is an empty one
  return { data: data ?? (failed ? EMPTY : null), reload: refresh };
}

export const postJson = (url: string, body: unknown): Promise<Response> =>
  connections.current().fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** The server's fixed refusals (server/src/projects.ts, projectRoutes.ts), in the page's language; any other text (a launcher's line) as it is. */
const REASONS = {
  'no such window': 'whyNoWindow', 'window not answering': 'whyNotAnswering', 'not a folder': 'whyNotFolder', 'not readable': 'whyNotReadable',
  'not writable': 'whyNotWritable', 'git init failed': 'whyGitInit', 'bad request': 'whyBadRequest', 'bad answer': 'whyBadRequest',
  'still starting': 'startStill', exists: 'startExists', refused: 'whyRefused',
} as const;
export const reasonText = (why: string): string => (why in REASONS ? t(REASONS[why as keyof typeof REASONS]) : why);

/**
 * Why another computer's window did not open (issue 297): the connector's refusals (POST /system/remote/open) and the codes
 * a desktop proxy sends back with a failed switch (`/?enter=<code>`, server/src/remote/proxy.ts). Anything else is the
 * generic failure, never its raw text.
 */
const REMOTE_WHY = {
  'no such window': 'whyNoWindow', 'no-window': 'whyNoWindow', 'not-answering': 'whyNotAnswering', 'not connected': 'whyNotConnected',
  'not-connected': 'whyNotConnected', 'not running': 'whyNotConnected', login: 'whyNotLoggedIn',
} as const;
const remoteWhy = (why: unknown): string => t(typeof why === 'string' && why in REMOTE_WHY ? REMOTE_WHY[why as keyof typeof REMOTE_WHY] : 'whyRemoteFailed');

/** A switch from another computer's page that came back (`?enter=<code>`): says why once, and takes the code off the address. */
export function enterFailure(loc: Location = location, hist: History = history): void {
  const code = new URLSearchParams(loc.search).get('enter');
  if (code === null) return;
  hist.replaceState(null, '', loc.pathname + loc.hash);
  toast(t('projEnterFailed', remoteWhy(code)), '');
}

/** A failed answer's reason: the server's short text, or the status. */
export const reasonOf = async (r: Response): Promise<string> => (await r.text().catch(() => '')).trim() || String(r.status);

/** Removes a folder from Recent (POST /system/projects/forget): null, or the reason it failed. */
export async function forgetRecent(root: string): Promise<string | null> {
  try {
    const r = await postJson(routes.systemProjects('forget'), { root });
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
    nav.go(routes.systemRemoteEnter(row.remote ? { host: row.remote.host, port: String(row.port) } : { provider: row.provider, port: String(row.port), root: row.root }));
    return true;
  }
  try {
    const r = row.remote
      ? await postJson(routes.systemRemoteOpen(), { host: row.remote.host, port: row.port })
      : await postJson(routes.systemProjects('enter'), { provider: row.provider, port: row.port, root: row.root, ...(session ? { session } : {}) });
    // the remote routes say why as JSON `{error}`, the switcher's as text
    if (!r.ok) {
      const why = row.remote ? remoteWhy(((await r.json().catch(() => null)) as { error?: unknown } | null)?.error) : reasonText(await reasonOf(r));
      toast(t('projEnterFailed', why), row.root);
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
    const r = await postJson(routes.systemProjects('stop'), { provider: row.provider, port: row.port, root: row.root });
    return r.ok ? null : await reasonOf(r);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
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
      ? await postJson(routes.systemProjects('create'), { parent: dir, name: create.name, git: create.git, provider })
      : await postJson(routes.systemProjects('open'), { dir, provider });
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
