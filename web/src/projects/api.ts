// The project switcher's and the starter's client side: the server routes of server/src/projectRoutes.ts, their answer
// types (mirrored: the web does not import from server/), the polling hook, and the move of this tab to another window.
import { useEffect, useState } from 'react';
import { t } from '@/i18n/index.ts';
import { apiFetch } from '@/net/auth.ts';
import { toast } from '@/shell/toast.ts';

export type Provider = 'claude' | 'codex' | 'omp';
export type ProjectState = 'working' | 'waiting' | 'idle' | 'restarting' | 'silent';
export type RunningRow = { provider: Provider; port: number; root: string; title: string | null; session: string | null; state: ProjectState; current: boolean; clients: number };
export type RecentRow = { root: string; provider: Provider; at: number; running: boolean };
export type ProjectsList = { running: RunningRow[]; recent: RecentRow[] };

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

/** GET /system/projects: every 3 s while `active` (the menu is open), every 10 s otherwise; only while the page is visible. */
export function useProjects(active: boolean): { data: ProjectsList | null; reload(): void } {
  const [data, setData] = useState<ProjectsList | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let gone = false;
    const load = () => {
      if (document.visibilityState === 'hidden') return;
      apiFetch('/system/projects')
        .then((r) => (r.ok ? r.json() : null))
        .then((j: unknown) => { if (!gone) setData(isList(j) ? j : { running: [], recent: [] }); })
        .catch(() => { /* the next poll tries again; the header's own line says when the server is gone */ });
    };
    load();
    const timer = setInterval(load, active ? 3000 : 10_000);
    return () => { gone = true; clearInterval(timer); };
  }, [active, tick]);
  return { data, reload: () => setTick((n) => n + 1) };
}

export const postJson = (url: string, body: unknown): Promise<Response> =>
  apiFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** A failed answer's reason: the server's short text, or the status. */
export const reasonOf = async (r: Response): Promise<string> => (await r.text().catch(() => '')).trim() || String(r.status);

/** Moves this tab to the window of `row`, logged in; a refusal is a toast and the tab stays. */
export async function enterProject(row: RunningRow): Promise<void> {
  try {
    const r = await postJson('/system/projects/enter', { provider: row.provider, port: row.port, root: row.root });
    if (!r.ok) return toast(t('projEnterFailed', await reasonOf(r)), row.root);
    const { url } = (await r.json()) as { url?: unknown };
    if (typeof url !== 'string') return toast(t('projEnterFailed', 'bad answer'), row.root);
    nav.go(url);
  } catch (e) {
    toast(t('projEnterFailed', e instanceof Error ? e.message : String(e)), row.root);
  }
}

/** The starter's open handle (Starter.tsx mounts the dialog and listens). */
let starter: ((mode: 'open' | 'new') => void) | null = null;
export const setStarter = (f: ((mode: 'open' | 'new') => void) | null): void => { starter = f; };
export const openStarter = (mode: 'open' | 'new'): void => starter?.(mode);

/** Opens `dir` in a window of `provider` (started if none) and moves this tab there; resolves to the refusal's reason, or null. */
export async function openFolder(dir: string, provider: Provider, create?: { name: string; git: boolean }): Promise<string | null> {
  try {
    const r = create
      ? await postJson('/system/projects/create', { parent: dir, name: create.name, git: create.git, provider })
      : await postJson('/system/projects/open', { dir, provider });
    if (!r.ok) return reasonOf(r);
    const { url } = (await r.json()) as { url?: unknown };
    if (typeof url !== 'string') return 'bad answer';
    nav.go(url);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
