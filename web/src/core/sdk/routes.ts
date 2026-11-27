// The server's routes, built in one place (issue 511): a builder returns a Route (path and query, no base), which goes to
// `conn.fetch(route)`, or to `conn.url(route)` for an img, video or iframe src. Query values are percent-encoded;
// an undefined one is left out.
import { agentPath } from '@nota-bene/shared';

/** A route: path and query, no base. */
export type Route = string;

type Value = string | number | undefined;
const q = (path: string, params: Record<string, Value>): Route => {
  const s = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  return s ? `${path}?${s}` : path;
};
const seg = encodeURIComponent;
/** the checkout itself is no source on the wire */
const source = (src: string | undefined): string | undefined => (src && src !== 'here' ? src : undefined);

export const routes = {
  // files
  /** a project file's bytes; `download`: saved, not shown */
  file: (path: string, o: { src?: string; download?: boolean } = {}) => q('/file', { path, src: source(o.src), download: o.download ? 1 : undefined }),
  tmpImage: (abs: string, bust = 0) => q('/tmpimage', { path: abs, r: bust || undefined }),
  tree: (path: string, src?: string) => q('/tree', { path, src: source(src) }),
  complete: (text: string) => q('/complete', { q: text }),
  sources: () => '/sources',
  edit: (path?: string) => (path === undefined ? '/edit' : q('/edit', { path })),
  /** POST: reveal, open with the system's app */
  os: (action: 'reveal' | 'open') => `/os/${seg(action)}`,

  // attachments, voice, media marks
  /** a pasted image (GET `/attach/<id>`); POST `/attach` uploads one */
  attach: (id?: string) => (id === undefined ? '/attach' : `/attach/${seg(id)}`),
  attachFile: (name: string) => q('/attach-file', { name }),
  voice: (id?: string) => (id === undefined ? '/voice' : `/voice/${seg(id)}`),
  voiceText: (id: string, lang: string, detect?: boolean) => q(`/voice/${seg(id)}/text`, { lang, detect: detect ? 1 : undefined }),
  marks: (id: string, name?: string) => (name === undefined ? `/marks/${seg(id)}` : `/marks/${seg(id)}/${seg(name)}`),

  // git
  gitStatus: () => '/git-status',
  gitSwitch: () => '/git-switch',
  vcsBranches: () => '/vcs-branches',
  vcsDiff: (src: string, base?: string) => q('/vcs-diff', { src, base: base || undefined }),
  vcsFile: (src: string, path: string, o: { base?: string; old?: string } = {}) => q('/vcs-file', { src, path, base: o.base || undefined, old: o.old || undefined }),
  vcsLog: (src: string, all: boolean) => q('/vcs-log', { src, all: all ? '1' : '0' }),
  vcsCommit: (sha: string) => q('/vcs-commit', { sha }),
  vcsCommitFile: (sha: string, path: string, old?: string) => q('/vcs-commit-file', { sha, path, old: old || undefined }),

  // the session and its agent
  /** POST: the one-time login token for the cookie */
  auth: () => '/auth',
  info: () => '/info',
  sessions: () => '/sessions',
  history: (session: string, before: number) => q('/history', { session, before }),
  /** with a session: that session's stored prompts; without: the current one's, or POST one */
  prompts: (session?: string) => q('/prompts', { session }),
  /** POST: answers an agent's open ask from the server's home page (issue 651), whose base is the top */
  agentPermission: (agent: string) => `${agentPath(seg(agent))}/permission`,
  stop: () => '/stop',
  restartServer: (what?: 'pause' | 'cancel') => (what ? `/restart-server/${what}` : '/restart-server'),
  agentAccount: () => '/agent-account',
  subagent: (session: string, tool: string) => q('/subagent', { session, tool }),
  taskOutput: (session: string, task: string) => q('/task-output', { session, task }),
  usage: (provider: string, period: string) => q('/usage', { provider, period }),
  usageReset: () => '/usage/reset',
  dictation: (action?: 'install' | 'on' | 'remove' | 'lang') => (action ? `/dictation/${action}` : '/dictation'),

  // the cut editor
  cutNew: () => '/cut/new',
  cutPeaks: (path: string) => q('/cut/peaks', { path }),
  cutReverse: (path: string, from: number, to: number, sound?: boolean) => q('/cut/reverse', { path, in: from, out: to, sound: sound ? 1 : undefined }),
  cutExport: (path?: string) => (path === undefined ? '/cut/export' : q('/cut/export', { path })),
  cutExportCancel: () => '/cut/export/cancel',

  // this computer's phones and the computers it reaches (server/src/remote/routes.ts): POSTs
  remote: (action: 'config' | 'pair' | 'pair/cancel' | 'revoke' | 'connect' | 'forget') => `/remote/${action}`,

  // the machine: every window, prefs, updates
  systemPrefs: () => '/system/prefs',
  systemAbout: () => '/system/about',
  systemShortcut: (action?: 'install') => (action ? `/system/shortcut/${action}` : '/system/shortcut'),
  systemStorage: () => '/system/storage',
  systemStorageClean: () => '/system/storage/clean',
  systemAgents: () => '/system/agents',
  systemFolders: () => '/system/folders',
  /** the switcher's list; with an action a POST */
  systemProjects: (action?: 'enter' | 'open' | 'create' | 'stop' | 'stop-others' | 'forget' | 'sessions') => (action ? `/system/projects/${action}` : '/system/projects'),
  /** the update's status; with an action a POST */
  systemUpdate: (action?: 'install' | 'restart' | 'auto') => (action ? `/system/update/${action}` : '/system/update'),
  systemUpdateChanges: (from?: string) => q('/system/update/changes', { from }),
  systemRemotePage: () => '/system/remote/page',
  systemRemoteOpen: () => '/system/remote/open',
  /** a navigation, not a fetch: another computer's window through this one's proxy */
  systemRemoteEnter: (p: Record<string, string>) => q('/system/remote/enter', p),
} satisfies Record<string, (...a: never[]) => Route>;
