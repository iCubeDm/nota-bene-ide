// The Settings tab's server side (M6-15): windows, storage, defaults, about. Plus the control routes another window's
// server uses to restart or stop this one.
//
// Cross-window control: a page may only talk to its own server (Origin check), so window A's page asks A's server,
// and A's server relays to B's `/control/<action>` with the per-user control token (`<stateDir>/control-token`,
// mode 600). A browser page never sees the token, so no web page can drive /control; any process of the same user
// could read the file, which is the same trust the state dir already has. A relay goes only to a registered window
// whose pid is alive and whose /info answers with the registered root (a reused port gets nothing, not the token).
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isThemeId, isUiLang, isUiScale, MODES, type AgentMode as Mode } from '@nota-bene/shared';
import { stateSecret } from './auth.ts';
import { reportError } from './errors.ts';
import type { EventHub } from './hub.ts';
import { DEFAULT_SOUNDS, isShellChoice, isSounds, readPrefs, setAuditPref, setDefaultModePref, setLangPref, setProjectRailPref, setShellPref, setSoundsPref, setThemePref, setUiScalePref, setUpdateCheckPref } from './prefs.ts';
import { winShells } from './session/shell.ts';
import { auditDir } from './audit.ts';
import { defaultProjectsDir } from './sessions.ts';
import { HIDDEN, renameRetry } from './platform.ts';
import { installShortcut, shortcutInstalled, shortcutPath } from './shortcut.ts';
import { changelog, isNewer, RELEASE, updateCheck, updateCheckForcedOff } from './update.ts';
import type { Updater } from './updater.ts';
import { readVersion } from './version.ts';

export const CONTROL_HEADER = 'x-nota-bene-control';
/** gh-422: `restart-server` waits for the agent's pause; `-now` cuts the turn, `-cancel` drops a pending one */
export const CONTROL_ACTIONS = ['restart-agent', 'restart-server', 'restart-server-now', 'restart-server-cancel', 'stop'] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];
/** An attachment younger than this is kept by "clean": an open draft may hold it (the server cannot see drafts). */
export const CLEAN_MIN_AGE_MS = 24 * 3600_000;
const ID_RE = /[0-9a-f]{64}/g;

/** The per-user control token, created once (mode 600). */
export const controlToken = (): string => stateSecret('control-token');

export function tokenOk(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string') return false;
  // latin1: one byte per char as Node decoded the header, so a stray non-ASCII byte cannot make the lengths differ
  const a = Buffer.from(header, 'latin1');
  const b = Buffer.from(token, 'latin1');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Bytes and file count under `dir`; symlinks are counted as links, never followed. A missing dir is zero. */
export function dirSize(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (d: string) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.isFile()) {
        try {
          bytes += fs.lstatSync(p).size;
          files++;
        } catch { /* vanished meanwhile */ }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

/** Every 64-hex id mentioned in any comments file: conservative (a stray match only keeps more). */
function referencedIds(commentsDir: string): Set<string> {
  const out = new Set<string>();
  let names: string[];
  try {
    names = fs.readdirSync(commentsDir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(commentsDir, n), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(ID_RE)) out.add(m[0]);
  }
  return out;
}

/**
 * Attachments no comment references and older than CLEAN_MIN_AGE_MS. Session transcripts are not scanned: a replay
 * re-creates any image of its transcript under the same content id, so trashing one loses nothing.
 */
export function cleanCandidates(stateDir: string, now = Date.now()): { files: string[]; bytes: number } {
  const dir = path.join(stateDir, 'attachments');
  const refs = referencedIds(path.join(stateDir, 'comments'));
  const files: string[] = [];
  let bytes = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { files, bytes };
  }
  for (const n of names) {
    const m = /^([0-9a-f]{64})\.[a-z]+$/.exec(n);
    if (!m || refs.has(m[1]!)) continue;
    try {
      const st = fs.lstatSync(path.join(dir, n));
      if (!st.isFile() || now - st.mtimeMs < CLEAN_MIN_AGE_MS) continue;
      files.push(n);
      bytes += st.size;
    } catch { /* vanished */ }
  }
  return { files, bytes };
}

/**
 * Moves the candidates to `<stateDir>/trash/attachments/<stamp>/` (never deletes; AttachmentStore.get brings one back
 * when it is read again). A file gone meanwhile is skipped; any other failure is reported, not swallowed.
 */
export function cleanAttachments(stateDir: string, now = Date.now()): { moved: number; bytes: number; trash: string; errors: string[] } {
  return moveToTrash(stateDir, 'attachments', cleanCandidates(stateDir, now).files, now);
}

const ARCHIVE_RE = /^([0-9a-zA-Z-]{1,100})\.jsonl$/;

/**
 * Archives (`<stateDir>/history/<id>.jsonl`, R-M7-1) whose session transcript is gone from every project: nothing
 * can resume that session, so nothing can page its archive in. A projects dir that cannot be read proves nothing
 * (a disk not mounted): then no archive is stale. An archive written within CLEAN_MIN_AGE_MS is never stale either
 * (a window with another CLAUDE_CONFIG_DIR may be writing it). The trash is the safety net for the rest.
 */
export function staleArchives(stateDir: string, projectsDir = defaultProjectsDir(), now = Date.now()): { files: string[]; bytes: number } {
  const dir = path.join(stateDir, 'history');
  const files: string[] = [];
  let bytes = 0;
  let projects: string[];
  let names: string[];
  try {
    projects = fs.readdirSync(projectsDir).map((p) => path.join(projectsDir, p));
    names = fs.readdirSync(dir);
  } catch {
    return { files, bytes };
  }
  for (const n of names) {
    const m = ARCHIVE_RE.exec(n);
    if (!m || projects.some((p) => fs.existsSync(path.join(p, `${m[1]!}.jsonl`)))) continue;
    try {
      const st = fs.lstatSync(path.join(dir, n));
      if (!st.isFile() || now - st.mtimeMs < CLEAN_MIN_AGE_MS) continue;
      files.push(n);
      bytes += st.size;
    } catch { /* vanished */ }
  }
  return { files, bytes };
}

/** Moves the stale archives to `<stateDir>/trash/history/<stamp>/` (never deletes), as cleanAttachments does. */
export function cleanStaleArchives(stateDir: string, projectsDir = defaultProjectsDir(), now = Date.now()): { moved: number; bytes: number; trash: string; errors: string[] } {
  return moveToTrash(stateDir, 'history', staleArchives(stateDir, projectsDir, now).files, now);
}

function moveToTrash(stateDir: string, kind: 'attachments' | 'history', files: string[], now: number): { moved: number; bytes: number; trash: string; errors: string[] } {
  const src = path.join(stateDir, kind);
  const trash = path.join(stateDir, 'trash', kind, new Date(now).toISOString().replace(/[:.]/g, '-'));
  let moved = 0;
  let bytes = 0;
  const errors: string[] = [];
  if (files.length) fs.mkdirSync(trash, { recursive: true });
  for (const n of files) {
    try {
      const size = fs.lstatSync(path.join(src, n)).size;
      renameRetry(path.join(src, n), path.join(trash, n));
      moved++;
      bytes += size;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') errors.push(`${n}: ${code ?? String(e)}`); // e.g. EXDEV: the dir on another volume
    }
  }
  return { moved, bytes, trash, errors };
}

/**
 * The version About shows. A git checkout (`.git` right in `dir`, a directory or a worktree's file) says `git describe`;
 * an installed package has no checkout, so it says its own package.json version. Never `git describe` there: it would
 * describe whatever repository the install happens to sit in.
 */
export function describeVersion(dir: string): Promise<string> {
  if (!fs.existsSync(path.join(dir, '.git'))) return Promise.resolve(readVersion(dir) ?? 'unknown');
  return new Promise((resolve) => {
    execFile('git', ['describe', '--tags', '--always', '--dirty'], { cwd: dir, timeout: 3000, ...HIDDEN }, (e, out) => resolve(e ? 'unknown' : out.trim()));
  });
}

// once per process: the checkout does not change under a running server in a way About must follow, and a page
// looping requests at /system/about must not spawn a git per request
let version: Promise<string> | null = null;
const gitDescribe = (dir: string): Promise<string> => (version ??= describeVersion(dir));

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function text(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
const only = (method: string, req: IncomingMessage, res: ServerResponse): boolean => {
  if (req.method === method || (method === 'GET' && req.method === 'HEAD')) return true;
  text(res, 405, 'method not allowed', { allow: method === 'GET' ? 'GET, HEAD' : method });
  return false;
};
const MAX_BODY = 4096;
export async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c);
  }
  const v: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SyntaxError('not an object');
  return v;
}

export function systemRoutes(o: {
  hub: EventHub;
  modes?: readonly Mode[];
  /** the current project root (a switch changes it) */
  root: () => string;
  /** the agent's state folder (AgentContext): storage, clean, and About's state folder */
  stateDir: string;
  /** this server's port (known after listen) */
  port: () => number;
  /** the checkout the server runs from, for the version */
  repoDir: string;
  /** this window's part of the in-app update: the routes below only relay to it (tests stub it) */
  updater: Updater;
  /** the newer version on npm, or null (tests stub it) */
  newer?: (current: string) => Promise<string | null>;
  /** the CHANGELOG sections between two versions, or null (tests stub it) */
  changes?: (current: string, latest: string) => Promise<string | null>;
  control: Control;
  /** the app icon (server/src/shortcut.ts; tests stub it) */
  shortcut?: { path(): string | null; installed(): boolean; install(): string };
}): Record<string, RequestListener> {
  const fail = (res: ServerResponse, where: string, e: unknown) => {
    reportError(o.hub, where, e);
    if (!res.headersSent) text(res, 500, 'internal error');
  };

  // a window of another state dir (the dev launcher's, a test's) offers none: its icon would replace the real one, open
  // that state dir's projects and run that checkout
  const shortcut = o.shortcut ?? { path: () => (process.env.NOTA_BENE_HOME ? null : shortcutPath()), installed: () => shortcutInstalled(), install: () => installShortcut() };
  const newer = o.newer ?? updateCheck();
  const changes = o.changes ?? changelog();
  return {
    '/system/update': (req, res) => {
      if (!only('GET', req, res)) return;
      void o.updater.status().then((s) => json(res, 200, s)).catch((e: unknown) => fail(res, '/system/update', e));
    },
    // installs the newest release the machine has seen (never a version the page names); 409 where this window cannot update
    '/system/update/install': (req, res) => {
      if (!only('POST', req, res)) return;
      void (async () => {
        if (!(await o.updater.status()).canUpdate) return text(res, 409, 'cannot update');
        json(res, 200, await o.updater.install());
      })().catch((e: unknown) => fail(res, '/system/update/install', e));
    },
    // the reply goes out first, then the window exits for its launcher to hand it over
    '/system/update/restart': (req, res) => {
      if (!only('POST', req, res)) return;
      const r = o.updater.restart();
      if (r !== 'ok') return text(res, 409, r);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}', () => o.updater.replied()); // the exit waits for the reply, and checks the pause once more
    },
    '/system/update/auto': (req, res) => {
      if (!only('POST', req, res)) return;
      void readJson(req).then((b) => {
        const on = (b as { on?: unknown }).on;
        if (typeof on !== 'boolean') return text(res, 400, 'bad on');
        o.updater.setAuto(on);
        res.writeHead(204);
        res.end();
      }).catch((e: unknown) => (e instanceof SyntaxError || (e instanceof Error && e.message === 'body too large') ? text(res, 400, 'bad request') : fail(res, '/system/update/auto', e)));
    },
    // what the newer version changes, for the notice's popover: asked when it opens, never with the check off
    '/system/update/changes': (req, res) => {
      if (!only('GET', req, res)) return;
      // ?from=x.y.z: what the running version changed since that one ("Updated to" after a handover)
      const from = new URL(req.url ?? '/', 'http://x').searchParams.get('from');
      if (from !== null) {
        void o.updater.status().then(async (s) => {
          json(res, 200, { text: RELEASE.test(from) && RELEASE.test(s.current) && isNewer(s.current, from) ? await changes(from, s.current) : null });
        }).catch((e: unknown) => fail(res, '/system/update/changes', e));
        return;
      }
      void gitDescribe(o.repoDir).then(async (current) => {
        const latest = await newer(current);
        json(res, 200, { text: latest ? await changes(current, latest) : null });
      }).catch((e: unknown) => fail(res, '/system/update/changes', e));
    },
    // the tab's "Add Nota Bene to your apps" (epic 383): shown while this computer can have the icon and has none
    '/system/shortcut': (req, res) => {
      if (!only('GET', req, res)) return;
      const can = shortcut.path() !== null;
      json(res, 200, { can, installed: can && shortcut.installed() });
    },
    '/system/shortcut/install': (req, res) => {
      if (!only('POST', req, res)) return;
      if (shortcut.path() === null) return text(res, 409, 'no app icon here');
      try {
        json(res, 200, { path: shortcut.install() });
      } catch (e) {
        fail(res, '/system/shortcut/install', e);
      }
    },
    '/system/about': (req, res) => {
      if (!only('GET', req, res)) return;
      const port = o.port();
      const log = path.join(os.tmpdir(), `nota-bene-${port}.log`);
      void gitDescribe(o.repoDir).then((version) => json(res, 200, {
        version, stateDir: o.stateDir, logs: fs.existsSync(log) ? [log] : [], node: process.version, pid: process.pid,
      }), (e) => fail(res, '/system/about', e));
    },

    '/system/prefs': (req, res) => {
      if (req.method === 'POST') {
        void readJson(req).then((b) => {
          const { defaultMode: mode, lang, uiScale, theme, ifUnset, updateCheck, audit, sounds, shell, projectRail } = b as { defaultMode?: unknown; lang?: unknown; uiScale?: unknown; theme?: unknown; ifUnset?: unknown; updateCheck?: unknown; audit?: unknown; sounds?: unknown; shell?: unknown; projectRail?: unknown };
          if (mode === undefined && lang === undefined && uiScale === undefined && theme === undefined && updateCheck === undefined && audit === undefined && sounds === undefined && shell === undefined && projectRail === undefined) return text(res, 400, 'bad defaultMode');
          if (mode !== undefined && !((o.modes ?? MODES) as readonly unknown[]).includes(mode)) return text(res, 400, 'bad defaultMode');
          if (lang !== undefined && !isUiLang(lang)) return text(res, 400, 'bad lang');
          if (uiScale !== undefined && !isUiScale(uiScale)) return text(res, 400, 'bad uiScale');
          if (theme !== undefined && !isThemeId(theme)) return text(res, 400, 'bad theme');
          if (updateCheck !== undefined && typeof updateCheck !== 'boolean') return text(res, 400, 'bad updateCheck');
          if (audit !== undefined && typeof audit !== 'boolean') return text(res, 400, 'bad audit');
          if (sounds !== undefined && !isSounds(sounds)) return text(res, 400, 'bad sounds');
          if (shell !== undefined && !isShellChoice(shell)) return text(res, 400, 'bad shell');
          if (projectRail !== undefined && typeof projectRail !== 'boolean') return text(res, 400, 'bad projectRail');
          if (mode !== undefined) setDefaultModePref(mode as Mode);
          if (lang !== undefined) setLangPref(lang, ifUnset === true);
          if (uiScale !== undefined) setUiScalePref(uiScale);
          if (theme !== undefined) setThemePref(theme);
          if (updateCheck !== undefined) setUpdateCheckPref(updateCheck);
          if (audit !== undefined) setAuditPref(audit);
          if (sounds !== undefined) setSoundsPref(sounds);
          if (shell !== undefined) setShellPref(shell);
          if (projectRail !== undefined) setProjectRailPref(projectRail);
          json(res, 200, { ...(mode !== undefined ? { defaultMode: mode } : {}), ...(lang !== undefined ? { lang: readPrefs().lang ?? lang } : {}), ...(uiScale !== undefined ? { uiScale } : {}), ...(theme !== undefined ? { theme } : {}), ...(updateCheck !== undefined ? { updateCheck } : {}), ...(audit !== undefined ? { audit } : {}), ...(sounds !== undefined ? { sounds } : {}), ...(shell !== undefined ? { shell } : {}), ...(projectRail !== undefined ? { projectRail } : {}) });
        }).catch((e: unknown) => (e instanceof SyntaxError || (e instanceof Error && e.message === 'body too large') ? text(res, 400, 'bad request') : fail(res, '/system/prefs', e)));
        return;
      }
      if (!only('GET', req, res)) return;
      const prefs = readPrefs();
      json(res, 200, {
        defaultMode: prefs.defaultMode ?? (o.modes?.includes('auto') ? 'auto' : o.modes?.[0] ?? 'auto'),
        updateCheck: !updateCheckForcedOff() && prefs.updateCheck !== false,
        updateCheckForcedOff: updateCheckForcedOff(),
        audit: prefs.audit !== false,
        auditDir: auditDir(),
        projectRail: prefs.projectRail !== false,
        sounds: prefs.sounds ?? DEFAULT_SOUNDS, // read by every tab right before it sounds: a change applies at once
        // Windows only: the shell of `! cmd` (the setting, and where each choice is installed: null = not); elsewhere $SHELL runs it
        ...(process.platform === 'win32' ? { shell: prefs.shell ?? 'auto', shells: winShells() } : {}),
      });
    },

    '/system/storage': (req, res) => {
      if (!only('GET', req, res)) return;
      try {
        const sd = o.stateDir;
        const c = cleanCandidates(sd);
        const h = staleArchives(sd);
        json(res, 200, {
          attachments: dirSize(path.join(sd, 'attachments')),
          comments: dirSize(path.join(sd, 'comments')),
          history: dirSize(path.join(sd, 'history')),
          trash: dirSize(path.join(sd, 'trash')),
          marks: { ...dirSize(path.join(o.root(), '.nota-bene', 'marks')), root: o.root() },
          // what "clean" moves: unreferenced pasted images and the archives of deleted sessions
          unreferenced: { files: c.files.length + h.files.length, bytes: c.bytes + h.bytes },
        });
      } catch (e) {
        fail(res, '/system/storage', e);
      }
    },

    '/system/storage/clean': (req, res) => {
      if (!only('POST', req, res)) return;
      try {
        const a = cleanAttachments(o.stateDir);
        const h = cleanStaleArchives(o.stateDir);
        const trash = a.moved && h.moved ? path.join(o.stateDir, 'trash') : h.moved ? h.trash : a.trash;
        json(res, 200, { moved: a.moved + h.moved, bytes: a.bytes + h.bytes, trash, errors: [...a.errors, ...h.errors] });
      } catch (e) {
        fail(res, '/system/storage/clean', e);
      }
    },

    '/control/': controlRoute({ hub: o.hub, control: o.control }),
  };
}

export type Control = {
  /** run after the reply is out; `supervised` says whether restart-server can be caught by a launcher */
  supervised(): boolean; exiting(): boolean; restartServer(): void; restartServerNow?(): void; cancelRestart?(): void; stop(): void;
  /** an agent's (home has none: issue 639) */
  restartAgent?(): void;
  /** POST /control/open (epic 383): the server's agent for a folder, opened if needed; the answer's status and body */
  open?(body: unknown): Promise<{ status: number; body: unknown }>;
  /** POST /control/close (epic 383): this agent closes, the server and its other agents go on; the answer's status */
  close?(): number;
};

/** POST /control/<action>: reached only with the control token (http.ts lets /control/ through without an Origin when the token matches). */
export function controlRoute(o: { hub: EventHub; control: Control }): RequestListener {
  const fail = (res: ServerResponse, where: string, e: unknown) => {
    reportError(o.hub, where, e);
    if (!res.headersSent) text(res, 500, 'internal error');
  };
  return (req, res) => {
    if (!only('POST', req, res)) return;
    const action = (req.url ?? '').split('?')[0]!.slice('/control/'.length) as ControlAction;
    const open = action === ('open' as string) ? o.control.open : undefined;
    const close = action === ('close' as string) ? o.control.close : undefined;
    if (!(CONTROL_ACTIONS.includes(action) && (action !== 'restart-agent' || o.control.restartAgent)) && !open && !close) return text(res, 404, 'not found');
    if (o.control.exiting()) return text(res, 409, 'exiting'); // a stop or restart is already under way
    if (close) {
      const status = close();
      return status === 200 ? json(res, 200, { ok: true }) : text(res, status, 'the server\'s last agent');
    }
    if (open) {
      return void readJson(req).then(open).then(
        (r) => (typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.status, r.body)),
        (e: unknown) => (e instanceof SyntaxError || (e instanceof Error && e.message === 'body too large') ? text(res, 400, 'bad request') : fail(res, '/control/open', e)),
      );
    }
    if ((action === 'restart-server' || action === 'restart-server-now') && !o.control.supervised()) return text(res, 409, 'not supervised');
    // answer first: a restart or stop must not cut the reply
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"ok":true}', () => {
      if (action === 'restart-agent') o.control.restartAgent?.();
      else if (action === 'restart-server') o.control.restartServer();
      else if (action === 'restart-server-now') (o.control.restartServerNow ?? o.control.restartServer)();
      else if (action === 'restart-server-cancel') o.control.cancelRestart?.();
      else o.control.stop();
    });
  };
}
