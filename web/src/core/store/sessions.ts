import { defineResource, send } from '../sdk/repository.ts';
import { routes } from '../sdk/routes.ts';

/** GET /sessions (server/src/sessions.ts SessionsView): the sessions of this page's agent, of every folder. */
export type SessionsView = {
  current: string | null;
  root: string;
  /** `archived`: hidden by the menu's archive (the server's list) */
  sessions: { id: string; title: string; at: number; size: number; cwd: string; archived?: true }[];
};
export type SessionRow = SessionsView['sessions'][number];

const isView = (v: unknown): v is SessionsView => {
  const o = v as SessionsView;
  return !!o && typeof o.root === 'string' && Array.isArray(o.sessions);
};

/** Read when a menu opens (no poll): the Sessions menu and the project switcher. */
export const sessionsResource = defineResource<void, SessionsView>({
  id: 'sessions',
  key: () => '',
  route: () => routes.sessions(),
  parse: (text) => {
    const v: unknown = JSON.parse(text);
    if (!isView(v)) throw new Error('bad /sessions answer');
    return { ...v, sessions: v.sessions.filter((x) => typeof x?.cwd === 'string' && typeof x.id === 'string') };
  },
});

// The Sessions menu's writes (server/src/sessions.ts), shared by the menu, the chat tab and the feed's cleared line

/** A failed load's text for the menu: one short line, never an HTML error page. */
export const brief = (status: number | null, body: string): string => {
  const plain = /^\s*</.test(body) ? '' : body.replace(/\s+/g, ' ').trim();
  const s = plain || (status ? `HTTP ${status}` : '');
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
};

/** POSTs JSON to a /sessions route: null, or what went wrong. `done`: another status that also means it is done. */
const postSessions = async (route: string, body: object, done?: number): Promise<string | null> => {
  const r = await send(route, body).catch(() => null);
  return r?.ok || (r && r.status === done) ? null : brief(r?.status ?? null, r ? await r.text().catch(() => '') : '');
};

/** Renames a session (the open one or any other): null, or what went wrong. */
export const renameSession = (id: string, title: string) => postSessions('/sessions/rename', { id, title });
/** Archives (`on`) or restores a session in Nota Bene's own list: null, or what went wrong. */
export const archiveSession = (id: string, on: boolean) => postSessions('/sessions/archive', { id, archived: on });
/** Deletes a stored session for good (the agent's files and Nota Bene's own): null, or what went wrong. */
// a 404: the agent had it no more (deleted elsewhere, or twice); the server has cleaned up all the same
export const deleteSession = (id: string) => postSessions('/sessions/delete', { id }, 404);
