// The connector's state under `<stateBase>/remote/` (700): `host.key` (the host's X25519 private key, base64url),
// `devices.json` (the paired devices: the source of truth for who may connect), `device.key` and `hosts.json` (this
// computer as a device of other computers: its own key, and the computers it paired with, issue 297), `config.json` (the relay URL, access on or off), `last-error.json` (the relay's last refusal) and, on
// Windows, `control-secret` (what a client of the control pipe proves it holds, control.ts). All
// mode 600, written whole and renamed in, read with the token's checks (auth.ts readPrivateFile). Also the pairing
// derivations of CHANNEL.md.
import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readPrivateFile, writePrivateFile } from '../auth.ts';
import { SecretError, stateBaseDir } from '../state.ts';
import { generateKeyPair, publicOf, type KeyPair } from './noise.ts';

const tightened = new Set<string>();

export function remoteDir(): string {
  const dir = path.join(stateBaseDir(), 'remote');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!tightened.has(dir)) {
    if (process.getuid && fs.statSync(dir).uid !== process.getuid()) {
      throw new SecretError(`the folder ${dir} belongs to another user; refusing to use it`);
    }
    fs.chmodSync(dir, 0o700);
    tightened.add(dir);
  }
  return dir;
}

export const b64u = (b: Buffer): string => b.toString('base64url');

/** Strict base64url without padding: exactly `len` bytes, canonical encoding only. */
export function fromB64u(s: string, len: number): Buffer {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const b = Buffer.from(s, 'base64url');
  if (b.length !== len || b64u(b) !== s) throw new Error(`not ${len} bytes of base64url`);
  return b;
}

const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest();
export const hostId = (pub: Buffer): string => b64u(pub);
export const deviceHash = (pub: Buffer): string => b64u(sha256(pub));

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** What a person compares: the first 10 bytes of SHA-256(key), base32, `abcd-efgh-ijkl-mnop`. */
export function fingerprint(pub: Buffer): string {
  const bytes = sha256(pub).subarray(0, 10);
  let bits = 0, acc = 0, out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join('-');
}

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const JSON_RE = /^\{[\s\S]*\}$/;

function keyFile(name: string, what: string, hint: string): KeyPair {
  const file = path.join(remoteDir(), name);
  const have = readPrivateFile(file, KEY_RE, what, hint);
  if (have) {
    const priv = fromB64u(have, 32);
    return { priv, pub: publicOf(priv) };
  }
  const k = generateKeyPair();
  // two first starts agree on one key, as with the token
  return createOnce(file, b64u(k.priv)) ? k : settled(file, () => keyFile(name, what, hint));
}

export const hostKey = (): KeyPair =>
  keyFile('host.key', 'a host key (43 base64url characters)', 'delete it to make a new host key (every paired device then has to pair again)');

/** This computer's key as a device of other computers (issue 297): separate from its host identity. */
export const deviceKey = (): KeyPair =>
  keyFile('device.key', 'a device key (43 base64url characters)', 'delete it to make a new device key (every computer this one connects to then has to be paired again)');

/** link() codes of a file system without hard links (as in auth.ts). */
const NO_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS']);

/**
 * Creates the private `file` with `content` once; false when another caller got there first. Written whole to a tmp
 * file ('wx') and linked in: the name appears only with its content, and the link fails if the file is there.
 * Without hard links (FAT/exFAT, some network shares): created in place with O_EXCL, still once-only (`settled` then
 * waits out the moment a reader may see it empty).
 */
function createOnce(file: string, content: string): boolean {
  const tmp = `${file}.new${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  try {
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if (!NO_LINKS.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      writeExclusive(file, content);
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

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

/** `read` of a file another caller has just created with `createOnce`: an empty one is waited for (~1 s). */
function settled<T>(file: string, read: () => T): T {
  for (let i = 0; ; i++) {
    try {
      return read();
    } catch (e) {
      let empty = false;
      try { empty = fs.lstatSync(file).size === 0; } catch { /* gone: the read says so */ }
      if (!empty || i >= 40) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

const SECRET_RE = /^[0-9a-f]{64}$/;

/** What proves a client of the Windows control pipe (control.ts): 32 random bytes as hex in `control-secret`, made once. */
export function controlSecret(): string {
  const file = path.join(remoteDir(), 'control-secret');
  const have = readPrivateFile(file, SECRET_RE, 'a secret (64 hex characters)', 'delete it to make a new one (a running `nota-bene remote` then has to be restarted)');
  if (have) return have;
  const t = randomBytes(32).toString('hex');
  // as the host key: two first callers agree on one secret
  return createOnce(file, t) ? t : settled(file, controlSecret);
}

export type Device = { id: string; pub: string; name?: string; addedAt: number };

function readJson(name: string, what: string): Record<string, unknown> | null {
  const file = path.join(remoteDir(), name);
  const t = readPrivateFile(file, JSON_RE, what, `delete it to start over`);
  if (t === null) return null;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    throw new SecretError(`${file} is not valid JSON; fix or delete it`);
  }
}

const devicesFile = () => path.join(remoteDir(), 'devices.json');

export function readDevices(): Device[] {
  const j = readJson('devices.json', 'the paired devices (JSON)');
  const list = j && Array.isArray(j.devices) ? (j.devices as Device[]) : [];
  return list.filter((d) => d && typeof d.id === 'string' && typeof d.pub === 'string' && KEY_RE.test(d.pub));
}

const writeDevices = (devices: Device[]) => writePrivateFile(devicesFile(), `${JSON.stringify({ v: 1, devices }, null, 2)}\n`);

/** The id of a new entry: the shortest of 4, 8 or 16 fingerprint characters no entry's id is a prefix of (or extends). */
function newId(pub: Buffer, list: { id: string }[]): string {
  const fp = fingerprint(pub).replace(/-/g, '');
  return [4, 8, 16].map((n) => fp.slice(0, n)).find((c) => !list.some((d) => d.id.startsWith(c) || c.startsWith(d.id))) ?? fp;
}

/** The entry whose id is or starts with `idOrPrefix`; null when none does; an ambiguous prefix throws. */
function byId<T extends { id: string }>(list: T[], idOrPrefix: string): T | null {
  const exact = list.find((d) => d.id === idOrPrefix);
  const matches = exact ? [exact] : list.filter((d) => idOrPrefix !== '' && d.id.startsWith(idOrPrefix));
  if (matches.length > 1) throw new Error(`"${idOrPrefix}" is ambiguous: ${matches.map((d) => d.id).join(', ')}`);
  return matches[0] ?? null;
}

/** Adds a device (idempotent for one key). */
export function addDevice(pub: Buffer, name?: string): Device {
  const devices = readDevices();
  const key = b64u(pub);
  const have = devices.find((d) => d.pub === key);
  if (have) return have;
  const d: Device = { id: newId(pub, devices), pub: key, ...(name ? { name: name.slice(0, 64) } : {}), addedAt: Date.now() };
  writeDevices([...devices, d]);
  return d;
}

/** Removes the device whose id is or starts with `idOrPrefix`; null when none does; an ambiguous prefix throws. */
export function removeDevice(idOrPrefix: string): Device | null {
  const devices = readDevices();
  const d = byId(devices, idOrPrefix);
  if (d) writeDevices(devices.filter((x) => x !== d));
  return d;
}

/** A computer this one paired with as a device (issue 297): where to reach it and the host key it pinned. */
export type Host = { id: string; relay: string; pub: string; name?: string; addedAt: number };

export function readHosts(): Host[] {
  const j = readJson('hosts.json', 'the paired computers (JSON)');
  const list = j && Array.isArray(j.hosts) ? (j.hosts as Host[]) : [];
  return list.filter((h) => h && typeof h.id === 'string' && typeof h.relay === 'string' && typeof h.pub === 'string' && KEY_RE.test(h.pub));
}

const writeHosts = (hosts: Host[]) => writePrivateFile(path.join(remoteDir(), 'hosts.json'), `${JSON.stringify({ v: 1, hosts }, null, 2)}\n`);

/** Saves a paired computer; one already saved with this key keeps its id and date and takes the new relay and name. */
export function addHost(o: { relay: string; pub: Buffer; name?: string }): Host {
  checkRelay(o.relay);
  const hosts = readHosts();
  const key = b64u(o.pub);
  const have = hosts.find((h) => h.pub === key);
  const h: Host = { id: have?.id ?? newId(o.pub, hosts), relay: o.relay, pub: key, ...(o.name ? { name: o.name.slice(0, 64) } : {}), addedAt: have?.addedAt ?? Date.now() };
  writeHosts(have ? hosts.map((x) => (x === have ? h : x)) : [...hosts, h]);
  return h;
}

/** Forgets the computer whose id is or starts with `idOrPrefix`; null when none does; an ambiguous prefix throws. */
export function removeHost(idOrPrefix: string): Host | null {
  const hosts = readHosts();
  const h = byId(hosts, idOrPrefix);
  if (h) writeHosts(hosts.filter((x) => x !== h));
  return h;
}

export function checkRelay(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol === 'wss:' || (u.protocol === 'ws:' && local && u.port !== '')) return;
  throw new Error(`the relay must be a wss:// URL (ws:// only on 127.0.0.1 or localhost with a port): ${url}`);
}

/** `enabled: false` is access turned off from a window (absent means on): windows then start no connector. */
export type RemoteConfig = { relay?: string; enabled?: boolean };

export function readConfig(): RemoteConfig {
  const j = readJson('config.json', 'the connector settings (JSON)');
  return { ...(j && typeof j.relay === 'string' ? { relay: j.relay } : {}), ...(j?.enabled === false ? { enabled: false } : {}) };
}

export function writeConfig(c: RemoteConfig): void {
  if (c.relay !== undefined) checkRelay(c.relay);
  const out = { ...(c.relay !== undefined ? { relay: c.relay } : {}), ...(c.enabled === false ? { enabled: false } : {}) };
  writePrivateFile(path.join(remoteDir(), 'config.json'), `${JSON.stringify(out, null, 2)}\n`);
}

/** Why the relay refused the host for good (a code it closed with, relayClient.ts FATAL): the windows show it. */
export type LastError = { code: number; message: string; at: number };
const lastErrorFile = () => path.join(remoteDir(), 'last-error.json');

export function readLastError(): LastError | null {
  const j = readJson('last-error.json', 'the relay\'s last refusal (JSON)');
  return j && typeof j.code === 'number' && typeof j.message === 'string' && typeof j.at === 'number' ? { code: j.code, message: j.message, at: j.at } : null;
}

export const writeLastError = (e: LastError): void => writePrivateFile(lastErrorFile(), `${JSON.stringify(e)}\n`);
export const clearLastError = (): void => fs.rmSync(lastErrorFile(), { force: true });

/**
 * The access key the relay's operator gave this person (`nb-relay invite`): `nbk1_` + base64url of an Ed25519 seed. Kept
 * as that text in `access-key`; every relay connection is signed with it (relayClient.ts). The page only learns that one
 * is set.
 */
const ACCESS_RE = /^nbk1_[A-Za-z0-9_-]{43}$/;

/** The seed of an access key typed or pasted by the person; the message says what is wrong, never repeats the input. */
export function parseAccessKey(code: string): Buffer {
  const c = code.trim();
  if (c.startsWith('nbremote:')) throw new Error('this is a phone pairing code, not an access key; an access key starts with nbk1_');
  if (!ACCESS_RE.test(c)) throw new Error('an access key starts with nbk1_ and has 48 characters');
  return fromB64u(c.slice(5), 32);
}

const accessKeyFile = (): string => path.join(remoteDir(), 'access-key');

export function readAccessKey(): Buffer | null {
  const have = readPrivateFile(accessKeyFile(), ACCESS_RE, 'an access key (nbk1_ and 43 base64url characters)', 'enter the access key again in the Remote tab or with `nota-bene remote key`');
  return have ? fromB64u(have.slice(5), 32) : null;
}

/** Saves a checked access key, or removes it (null). */
export function writeAccessKey(code: string | null): void {
  if (code === null) return void fs.rmSync(accessKeyFile(), { force: true });
  parseAccessKey(code);
  writePrivateFile(accessKeyFile(), `${code.trim()}\n`);
}

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const memberKey = (seed: Buffer): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });

/** The access key's public half: the member id the relay knows. */
export const memberPub = (seed: Buffer): Buffer => fromB64u(createPublicKey(memberKey(seed)).export({ format: 'jwk' }).x!, 32);

/** Ed25519 over "nb-relay-v1 member" ‖ nonce ‖ eph ‖ host public key (relay/PROTOCOL.md, Admission). */
export const memberSign = (seed: Buffer, nonce: Buffer, eph: Buffer, hostPub: Buffer): Buffer =>
  sign(null, Buffer.concat([Buffer.from('nb-relay-v1 member'), nonce, eph, hostPub]), memberKey(seed));

/** What the host hands the relay while a pairing is in flight: the relay never learns the secret. */
export const pairTicket = (secret: Buffer): Buffer => createHmac('sha256', secret).update('nb-relay-ticket-v1').digest();
/** What the phone puts in handshake message 1 to prove it scanned the QR, bound to its own key. */
export const pairProof = (secret: Buffer, phonePub: Buffer): Buffer => createHmac('sha256', secret).update('nb-pair-v1').update(phonePub).digest();

export function pairUri(o: { relay: string; hostPub: Buffer; secret: Buffer }): string {
  return `nbremote://pair?v=1&r=${encodeURIComponent(o.relay)}&h=${hostId(o.hostPub)}&s=${b64u(o.secret)}`;
}

export function parsePairUri(s: string): { relay: string; hostPub: Buffer; secret: Buffer } {
  const m = /^nbremote:\/\/pair\?(.*)$/.exec(s);
  if (!m) throw new Error('not a pairing code');
  const q = new URLSearchParams(m[1]);
  if (q.get('v') !== '1') throw new Error('unsupported pairing code version');
  const relay = q.get('r') ?? '';
  checkRelay(relay);
  return { relay, hostPub: fromB64u(q.get('h') ?? '', 32), secret: fromB64u(q.get('s') ?? '', 32) };
}
