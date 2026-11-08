// The connector's state under `<stateBase>/remote/` (700): `host.key` (the host's X25519 private key, base64url),
// `devices.json` (the paired phones: the source of truth for who may connect) and `config.json` (the relay URL). All
// mode 600, written whole and renamed in, read with the token's checks (auth.ts readPrivateFile). Also the pairing
// derivations of CHANNEL.md.
import { createHash, createHmac } from 'node:crypto';
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

export function hostKey(): KeyPair {
  const file = path.join(remoteDir(), 'host.key');
  const have = readPrivateFile(file, KEY_RE, 'a host key (43 base64url characters)', 'delete it to make a new host key (every paired phone then has to pair again)');
  if (have) {
    const priv = fromB64u(have, 32);
    return { priv, pub: publicOf(priv) };
  }
  const k = generateKeyPair();
  // 'wx' through a link: two first starts agree on one key, as with the token
  const tmp = `${file}.new${process.pid}`;
  fs.writeFileSync(tmp, b64u(k.priv), { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(tmp, file);
    return k;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return hostKey();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
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

/** Adds a phone (idempotent for one key). Its id is the shortest of 4, 8 or 16 fingerprint characters not taken. */
export function addDevice(pub: Buffer, name?: string): Device {
  const devices = readDevices();
  const key = b64u(pub);
  const have = devices.find((d) => d.pub === key);
  if (have) return have;
  const fp = fingerprint(pub).replace(/-/g, '');
  const id = [4, 8, 16].map((n) => fp.slice(0, n)).find((c) => !devices.some((d) => d.id.startsWith(c) || c.startsWith(d.id))) ?? fp;
  const d: Device = { id, pub: key, ...(name ? { name: name.slice(0, 64) } : {}), addedAt: Date.now() };
  writeDevices([...devices, d]);
  return d;
}

/** Removes the device whose id is or starts with `idOrPrefix`; null when none does; an ambiguous prefix throws. */
export function removeDevice(idOrPrefix: string): Device | null {
  const devices = readDevices();
  const exact = devices.find((d) => d.id === idOrPrefix);
  const matches = exact ? [exact] : devices.filter((d) => idOrPrefix !== '' && d.id.startsWith(idOrPrefix));
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error(`"${idOrPrefix}" is ambiguous: ${matches.map((d) => d.id).join(', ')}`);
  writeDevices(devices.filter((d) => d !== matches[0]));
  return matches[0]!;
}

function checkRelay(url: string): void {
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

export function readConfig(): { relay?: string } {
  const j = readJson('config.json', 'the connector settings (JSON)');
  return j && typeof j.relay === 'string' ? { relay: j.relay } : {};
}

export function writeConfig(c: { relay?: string }): void {
  if (c.relay !== undefined) checkRelay(c.relay);
  writePrivateFile(path.join(remoteDir(), 'config.json'), `${JSON.stringify(c, null, 2)}\n`);
}

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
