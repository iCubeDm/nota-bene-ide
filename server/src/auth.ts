// The local access token: nothing on the machine reaches the API or the socket without it.
//
// One secret per state dir (`<stateDir>/token`, 32 random bytes as hex, mode 600, created with an exclusive link so two
// first launches agree). It never travels in argv, env or a log: the server and the helpers read the file.
//
// Everything a client holds is derived from the token, the port AND a per-launch nonce (the launcher makes it and passes it
// to every server it starts: exit 75 keeps it, a crash relaunch takes a new one; an unsupervised server makes its own). The nonce is
// public, not a secret. A value captured from one launch is dead at the next, and one captured for a port is dead on any
// other. Derived values, each with its own label:
//   cookie  `nb_<port>`      HttpOnly, opens only `/file` and `/attach/<id>` (what <img>, <video> and <audio> load without
//                            headers): a browser sends it to every port on 127.0.0.1, so on its own it must not open
//                            anything else (not /info, not the socket, not a write)
//   key                      what the page keeps in localStorage (origin-scoped, port included); with the cookie it opens
//                            every other route and /ws (header `x-nota-bene-key`, or the `nb.<key>` WebSocket subprotocol).
//                            A new route needs the key unless `cookieRoute` is changed on purpose
//   login                    what the URL fragment `#t=` carries and POST /auth accepts (never the raw token): one launch only
//   helper bearer            what a helper sends as Authorization: both tiers
//   proof                    what GET /hello answers for a challenge: a helper sends nothing (not even a derived value)
//                            to a port until its listener proves it holds the token (verifiedBearer)
// The raw token as a Bearer also opens both tiers (a script of the user's own). The token is readable by any process of the
// same OS user (the agent too): the aim is to shut out other users and software that cannot read the file.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { renameRetry } from './platform.ts';
import { SecretError, stateDir } from './state.ts';

export { SecretError };

const TOKEN_RE = /^[0-9a-f]{64}$/;
/** how long a browser keeps its login (a year); deleting the token file rotates it at the next server start */
export const COOKIE_MAX_AGE_S = 365 * 24 * 3600;

/**
 * Reads a state secret with the ssh rule: only a missing file (ENOENT) means "none yet, make one". A symlink, a FIFO or other
 * non-regular file, a file of another user, a file readable by group or other, and unreadable or garbage content all throw, naming
 * the file and the fix. Nothing is ever replaced silently: a rotation under a live window would log everything out, and a
 * rotation race could hand two processes two tokens.
 * Windows: `stat` reports 666 for every file and there is no uid, so the owner and mode checks are skipped and the user
 * profile's ACL is trusted (`stateDir` refuses a state folder outside the profile). A symlink or a junction is still
 * refused, with `lstat` (O_NOFOLLOW does not exist there).
 */
function readSecret(file: string): string | null {
  return readPrivateFile(file, TOKEN_RE, 'a token (64 hex characters)', 'delete it to make a new token (every open window then has to be reopened)');
}

const WIN = process.platform === 'win32';
// both are undefined on Windows: never OR an undefined into the flags (it becomes 0 and the refusal silently goes)
const NOFOLLOW_NONBLOCK = WIN ? 0 : fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/**
 * `readSecret`'s checks for any private file: `valid` is what its trimmed content must match, `what` names that content,
 * `remedy` says what deleting it does.
 */
export function readPrivateFile(file: string, valid: RegExp, what: string, remedy: string): string | null {
  const fix = WIN ? remedy : `fix it with \`chmod 600 ${file}\`, or ${remedy}`;
  const isLink = () => new SecretError(`${file} is a symbolic link; refusing to read it. ${cap(remedy)}`);
  const notFile = () => new SecretError(`${file} is not a regular file; refusing to read it. ${cap(remedy)}`);
  let fd: number;
  let seen: fs.Stats | undefined;
  try {
    if (WIN) {
      // no O_NOFOLLOW: lstat first (a symlink or a junction is a link to it), and the open must land on that same file
      seen = fs.lstatSync(file);
      if (seen.isSymbolicLink()) throw isLink();
      if (!seen.isFile()) throw notFile(); // a folder cannot be opened for reading there (EISDIR)
    }
    // O_NOFOLLOW: a symlink is refused (ELOOP); O_NONBLOCK: a FIFO cannot hang the open
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW_NONBLOCK);
  } catch (e) {
    if (e instanceof SecretError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw isLink();
    throw new SecretError(`cannot read ${file}: ${(e as Error).message}; ${fix}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (seen && (st.ino !== seen.ino || st.dev !== seen.dev)) throw new SecretError(`${file} was replaced while it was being opened; refusing to read it. ${cap(remedy)}`);
    if (!st.isFile()) throw notFile();
    if (!WIN) {
      if (process.getuid && st.uid !== process.getuid()) {
        throw new SecretError(`${file} belongs to another user (uid ${st.uid}); refusing to use it. ${cap(remedy)}`);
      }
      if (st.mode & 0o077) throw new SecretError(`${file} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); ${fix}`);
    }
    const t = fs.readFileSync(fd, 'utf8').trim();
    if (!valid.test(t)) throw new SecretError(`${file} does not hold ${what}; ${remedy}`);
    return t;
  } finally {
    fs.closeSync(fd);
  }
}

const cap = (s: string): string => s[0]!.toUpperCase() + s.slice(1);

/** Writes a private file whole: a tmp file (mode 600) in the same folder, then renamed over the old one. */
export function writePrivateFile(file: string, content: string): void {
  const tmp = `${file}.tmp${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  try {
    renameRetry(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** link() codes of a file system without hard links (as in marks.ts). */
const NO_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS']);

/** `content` into a new `file` (O_EXCL: EEXIST when it is there, even as a symlink); a failed write removes it again. */
function writeExclusive(file: string, content: string): void {
  // Windows: CREATE_NEW follows a dangling symlink and creates its target; an lstat first keeps the symlink refused there
  if (process.platform === 'win32' && fs.lstatSync(file, { throwIfNoEntry: false })) throw Object.assign(new Error(`EEXIST: file already exists, open '${file}'`), { code: 'EEXIST' });
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeSync(fd, content);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
    throw e;
  }
  fs.closeSync(fd);
}

/** `readSecret` of a file another process has just created with `writeExclusive`: an empty one is waited for (~1 s). */
function settled(file: string): string | null {
  for (let i = 0; ; i++) {
    try {
      return readSecret(file);
    } catch (e) {
      let empty = false;
      try { empty = fs.lstatSync(file).size === 0; } catch { /* gone: the read says so */ }
      if (!empty || i >= 40) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** A secret kept in `<stateDir>/<name>`: read, or created once (mode 600). Concurrent first callers get one value. */
export function stateSecret(name: string): string {
  const dir = stateDir();
  const file = path.join(dir, name);
  const have = readSecret(file);
  if (have) return have;
  const t = randomBytes(32).toString('hex');
  // written whole to a tmp file ('wx': never into an existing one), then linked in: the name appears only with its content
  // (no reader sees it empty), and the link fails if another process got there first.
  // Without hard links (FAT/exFAT, some network shares): created in place with O_EXCL, still once-only; a reader may then
  // see it empty for a moment, so the loser of the race waits for the content (`settled`).
  const tmp = `${file}.tmp${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, t, { mode: 0o600, flag: 'wx' });
  let linked = true;
  try {
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if (!NO_LINKS.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      linked = false;
      writeExclusive(file, t);
    }
    return t;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const other = linked ? readSecret(file) : settled(file); // the other process's (throws if what is there is bad)
    if (other) return other;
    throw new SecretError(`${file} vanished while it was being created; try again`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** The access token of this state dir. */
export const accessToken = (): string => stateSecret('token');

export const cookieName = (port: number): string => `nb_${port}`;

const NONCE_RE = /^[0-9a-f]{32}$/;
export const isNonce = (n: unknown): n is string => typeof n === 'string' && NONCE_RE.test(n);
export const newNonce = (): string => randomBytes(16).toString('hex');

const mac = (token: string, label: string, port: number, nonce: string): string =>
  createHmac('sha256', token).update(`nota-bene:${label}:${port}:${nonce}`).digest('hex');
/** the HttpOnly cookie's value: read tier */
export const cookieCredential = (token: string, port: number, nonce: string): string => mac(token, 'cookie', port, nonce);
/** the page's key: with the cookie, write tier */
export const keyCredential = (token: string, port: number, nonce: string): string => mac(token, 'key', port, nonce);
/** what the login URL carries and POST /auth accepts: one launch, one port */
export const loginCredential = (token: string, port: number, nonce: string): string => mac(token, 'login', port, nonce);
/** a helper's Authorization: both tiers */
export const helperCredential = (token: string, port: number, nonce: string): string => mac(token, 'helper', port, nonce);

/** What GET /hello answers for challenge `c` on `port` in launch `n`: proves knowledge of the token, bound to all three. */
export const proofFor = (token: string, port: number, n: string, c: string): string =>
  createHmac('sha256', token).update(`nota-bene:proof:${port}:${n}:${c}`).digest('hex');

/** A challenge a helper may send: random hex, bounded (the server refuses anything else). */
export const CHALLENGE_RE = /^[0-9a-f]{16,64}$/;

export const KEY_HEADER = 'x-nota-bene-key';
export const KEY_PROTOCOL = 'nb.';

/**
 * Asks `host:dial` to prove it is a window of this state dir whose proof is bound to `bound` (the port it is listening on; for
 * the dev proxy that is the backend's, not the one dialled). Returns the launch nonce of a checked proof, else null. A bad or
 * missing proof means "not ours": the caller sends nothing. Fresh challenge per call, constant-time comparison.
 */
export async function proveListener(o: { dial: number; bound?: number; host?: string; timeoutMs: number; fetchFn?: typeof fetch; token?: string }): Promise<string | null> {
  const token = o.token ?? accessToken(); // a refused secret is the user's to fix: it throws, it is never "not ours"
  try {
    const c = randomBytes(16).toString('hex');
    const r = await (o.fetchFn ?? fetch)(`http://${o.host ?? '127.0.0.1'}:${o.dial}/hello?c=${c}`, { signal: AbortSignal.timeout(o.timeoutMs), redirect: 'error' });
    if (!r.ok) return null;
    const j = (await r.json()) as { proof?: unknown; n?: unknown } | null;
    if (!j || typeof j.proof !== 'string' || !isNonce(j.n)) return null;
    return sameSecret(j.proof, proofFor(token, o.bound ?? o.dial, j.n, c)) ? j.n : null;
  } catch {
    return null;
  }
}

/** `Authorization` value for a window on `port`, or null when its listener did not prove itself (nothing is sent to it). */
export async function verifiedBearer(port: number, timeoutMs: number, fetchFn?: typeof fetch, token?: string): Promise<string | null> {
  const n = await proveListener({ dial: port, timeoutMs, ...(fetchFn ? { fetchFn } : {}), ...(token ? { token } : {}) });
  return n === null ? null : `Bearer ${helperCredential(token ?? accessToken(), port, n)}`;
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();
/** Constant-time string equality (both sides hashed first, so length does not leak either). */
export function sameSecret(a: string | undefined, b: string): boolean {
  return a !== undefined && timingSafeEqual(digest(a), digest(b));
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The page's key from a request: the header (fetch) or the `nb.<key>` WebSocket subprotocol (the socket; never the URL). */
function keyOf(headers: IncomingHttpHeaders): string | undefined {
  const h = headers[KEY_HEADER];
  if (typeof h === 'string') return h;
  for (const p of String(headers['sec-websocket-protocol'] ?? '').split(',')) {
    const v = p.trim();
    if (v.startsWith(KEY_PROTOCOL)) return v.slice(KEY_PROTOCOL.length);
  }
  return undefined;
}

/**
 * The only routes the cookie opens without the key: what an element loads with no way to add a header (<img>, <video>,
 * <audio>, a 3D loader's textures). `/model` is NOT among them: the viewer fetches it, so it goes through `apiFetch`. Anything
 * not listed needs the key; a new route is in the key tier by default.
 */
export function cookieRoute(method: string | undefined, rawPath: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  // /voice/<id>: what <audio> plays a voice message from (not its /text)
  return rawPath === '/file' || (rawPath.startsWith('/attach/') && rawPath.length > '/attach/'.length) || /^\/voice\/[0-9a-f]{64}$/.test(rawPath);
}

/**
 * Authenticated for this launch (`nonce`). A Bearer (the helper's, or the raw token) opens everything. The cookie opens a
 * `cookieRoute`; `needKey` (every other route, and the socket) also needs the page's key.
 */
export function authenticated(headers: IncomingHttpHeaders, token: string, port: number, nonce: string, needKey: boolean): boolean {
  const m = /^Bearer (\S+)$/i.exec(headers.authorization ?? '');
  if (m && (sameSecret(m[1], helperCredential(token, port, nonce)) || sameSecret(m[1], token))) return true;
  if (!sameSecret(cookieValue(headers.cookie, cookieName(port)), cookieCredential(token, port, nonce))) return false;
  return !needKey || sameSecret(keyOf(headers), keyCredential(token, port, nonce));
}

/** The Set-Cookie value a successful /auth sends. */
export const sessionCookie = (token: string, port: number, nonce: string): string =>
  `${cookieName(port)}=${cookieCredential(token, port, nonce)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
