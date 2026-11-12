// The wire between a window's server and the Whisper host process (hostMain.ts): length-prefixed frames on a unix socket (a
// named pipe on Windows).
// A frame is [u32 headerLen][JSON header][u32 bodyLen][body], lengths big-endian. The body is raw 16-bit little-endian PCM
// (16 kHz mono, as wav.ts takes it) in a job and empty otherwise. Bad framing is a WireError and ends the connection.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readPrivateFile } from '../auth.ts';
import { pathKey, realpathNative } from '../platform.ts';
import { SecretError, stateBaseDir } from '../state.ts';
import { MAX_AUDIO, WHISPER_DTYPE, WHISPER_MODEL, WHISPER_PACKAGE, WHISPER_RATE, WHISPER_REVISION, WHISPER_VERSION } from './whisper.ts';

/** Bumped when the messages change incompatibly: it is part of the socket name, so hosts of different protocols never meet. */
export const HOST_PROTO = 1;
/** The pins of whisper.ts in eight hex digits: a host serves one set of pins, and the socket name carries them. */
export const HOST_PINS = createHash('sha256').update([WHISPER_PACKAGE, WHISPER_VERSION, WHISPER_MODEL, WHISPER_REVISION, WHISPER_DTYPE].join('\n')).digest('hex').slice(0, 8);
/** The header is a small JSON object (a transcript is in one too). */
export const MAX_HEADER = 64 * 1024;
/** One frame, header and body together: the most audio a request carries (whisper.ts, the HTTP routes' cap too) and a full header. */
export const MAX_FRAME = MAX_AUDIO + MAX_HEADER;

/** A model call gets the larger of this and JOB_DEADLINE_FACTOR times the audio's length (the host's own limit; the window's is built on it). */
export const JOB_DEADLINE_MIN_MS = 2 * 60_000;
export const JOB_DEADLINE_FACTOR = 10;
/** The model load gets this long while jobs wait for it (the model is on disk by then: this only unwedges a hung load). */
export const LOAD_DEADLINE_MS = 5 * 60_000;
/** How long a model call on `samples` of audio may take. */
export const jobDeadlineMs = (samples: number): number => Math.max(JOB_DEADLINE_MIN_MS, JOB_DEADLINE_FACTOR * samples * 1000 / WHISPER_RATE);

/** The host's folder, outside <stateBase>/whisper/ (Remove deletes that one while a host may still be answering). */
export const hostDir = (): string => path.join(stateBaseDir(), 'whisper-host');

/** A Windows named pipe, not a path on disk: there is no file to stat, rename or remove. */
export const isPipePath = (p: string): boolean => p.startsWith('\\\\.\\pipe\\');

/**
 * The host's socket; throws when the path does not fit a unix socket (the caller falls back to the in-process model). Windows:
 * the named pipe `\\.\pipe\nota-bene-whisper-<16 hex of SHA-256 of the real state base path>-h<proto>-<pins>`. Pipe names
 * are machine-wide, so the home is in the name, and a pipe gets the default ACL: the hello handshake (`helloProof`) proves
 * both ends hold the home's `host-secret` instead of the mode-600 socket.
 */
export function hostSocketPath(): string {
  if (process.platform === 'win32') {
    const home = createHash('sha256').update(pathKey(realpathNative(stateBaseDir()))).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\nota-bene-whisper-${home}-h${HOST_PROTO}-${HOST_PINS}`;
  }
  const p = path.join(hostDir(), `h${HOST_PROTO}-${HOST_PINS}.sock`);
  // sun_path holds 104 bytes on macOS, 108 on Linux (with the terminator)
  if (Buffer.byteLength(p) > 103) throw new Error(`the Whisper host socket path is too long for the system (${p}); use a shorter NOTA_BENE_HOME`);
  return p;
}

/** The folder is ours and private: created 700, an existing one tightened (every window talks to the socket in it). */
export function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.getuid && fs.statSync(dir).uid !== process.getuid()) throw new SecretError(`the Whisper host folder ${dir} belongs to another user; refusing to use it`);
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to tighten */ }
}

const HEX32 = /^[0-9a-f]{64}$/;

/**
 * What proves a window to the host and the host to the window on a Windows pipe: 32 random bytes as hex in
 * `<whisper-host>/host-secret`, made once (a write, then a link: two first callers agree on one), read with the token's checks.
 */
export function hostSecret(): string {
  const dir = hostDir();
  privateDir(dir);
  const file = path.join(dir, 'host-secret');
  const have = readPrivateFile(file, HEX32, 'a secret (64 hex characters)', 'delete it to make a new one (a running Whisper host is then replaced)');
  if (have) return have;
  const t = randomBytes(32).toString('hex');
  const tmp = `${file}.new${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, t, { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(tmp, file);
    return t;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return hostSecret();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * The pipe handshake: the host sends `challenge` with its nonce `ns` as the connection opens, the window's `hello` carries its
 * own nonce `nc` and its proof, the host's `hello` answer the host's. Each is HMAC-SHA-256 under the secret, so the secret
 * never crosses the pipe and a proof is good for one connection only.
 */
export const helloProof = (secret: string, side: 'window' | 'host', ns: string, nc: string): string =>
  createHmac('sha256', Buffer.from(secret, 'hex')).update(`nb-whisper-${side}\n${ns}\n${nc}`).digest('hex');

/** Whether `got` is the proof `want`, in constant time. */
export const proofMatches = (got: unknown, want: string): boolean =>
  typeof got === 'string' && HEX32.test(got) && timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'));

export const newNonce = (): string => randomBytes(32).toString('hex');

export type Header = Record<string, unknown>;
export type Frame = { header: Header; body: Buffer };

/** Malformed or oversized framing, or a message the host does not know. */
export class WireError extends Error {}

export type JobOpts = { lang: string; detect: boolean };
/** Why a job has no transcript: the queue is full, Whisper is off (removed), the model or the job failed, the client cancelled it. */
export type JobError = 'busy' | 'off' | 'failed' | 'cancelled';

/** What a window sends. A `job` carries its PCM as the frame body. On a pipe `hello` carries the window's nonce and proof. */
export type HostRequest =
  | { type: 'hello'; proto: number; nonce?: string; proof?: string }
  | { type: 'job'; id: number; opts: JobOpts }
  | { type: 'cancel'; id: number }
  | { type: 'shutdown'; reason: string }
  | { type: 'status' };

/**
 * What the host answers; a job's answer is the only one without a `type`. `full`, instead of `hello`, says that the host has all
 * the windows it takes: the connection closes after it. A `failed` answer may carry the model's message. On a pipe the host
 * sends `challenge` first, unasked, and its `hello` carries its proof.
 */
export type HostReply =
  | { type: 'challenge'; nonce: string }
  | { type: 'hello'; proto: number; pid: number; pins: string; loaded: boolean; queued: number; proof?: string }
  | { type: 'status'; loaded: boolean; queued: number; running: boolean; clients: number }
  | { type: 'full' }
  | { id: number; text: string; lang: string }
  | { id: number; error: JobError; message?: string };

/** One frame ready to write. Throws when it would exceed what the receiving end accepts. */
export function encodeFrame(header: Header, body: Uint8Array = new Uint8Array(0)): Buffer {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  if (head.length > MAX_HEADER) throw new WireError('the frame header is too large');
  if (head.length + body.length > MAX_FRAME) throw new WireError('the frame is too large');
  const out = Buffer.allocUnsafe(8 + head.length + body.length);
  out.writeUInt32BE(head.length, 0);
  head.copy(out, 4);
  out.writeUInt32BE(body.length, 4 + head.length);
  out.set(body, 8 + head.length);
  return out;
}

type Stage = 'headerLen' | 'header' | 'bodyLen' | 'body';

/**
 * Turns a socket's input into frames, whatever the chunking: a frame may arrive in pieces or several in one chunk. A length
 * over its cap throws as soon as the prefix is read, before any of the data is awaited. After a WireError the decoder stays failed.
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private stage: Stage = 'headerLen';
  private need = 4;
  private headerLen = 0;
  private header: Header = {};
  private failed: WireError | undefined;

  /** The frames completed by `chunk`. */
  push(chunk: Uint8Array): Frame[] {
    if (this.failed) throw this.failed;
    if (chunk.length) {
      this.chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
      this.buffered += chunk.length;
    }
    const frames: Frame[] = [];
    try {
      while (this.buffered >= this.need) this.step(this.take(this.need), frames);
    } catch (e) {
      this.failed = e instanceof WireError ? e : new WireError(String(e));
      throw this.failed;
    }
    return frames;
  }

  private step(b: Buffer, frames: Frame[]): void {
    if (this.stage === 'headerLen') {
      const n = b.readUInt32BE(0);
      if (n === 0 || n > MAX_HEADER) throw new WireError('bad frame header length');
      this.headerLen = n;
      this.advance('header', n);
    } else if (this.stage === 'header') {
      let h: unknown;
      try { h = JSON.parse(b.toString('utf8')); } catch { throw new WireError('the frame header is not JSON'); }
      if (!h || typeof h !== 'object' || Array.isArray(h)) throw new WireError('the frame header is not an object');
      this.header = h as Header;
      this.advance('bodyLen', 4);
    } else if (this.stage === 'bodyLen') {
      const n = b.readUInt32BE(0);
      if (this.headerLen + n > MAX_FRAME) throw new WireError('the frame is too large');
      if (n === 0) return this.done(frames, Buffer.alloc(0));
      this.advance('body', n);
    } else {
      this.done(frames, b);
    }
  }

  private advance(stage: Stage, need: number): void {
    this.stage = stage;
    this.need = need;
  }

  private done(frames: Frame[], body: Buffer): void {
    frames.push({ header: this.header, body });
    this.header = {};
    this.advance('headerLen', 4);
  }

  /** The next `n` buffered bytes (n <= buffered): a view when one chunk holds them, else one copy. */
  private take(n: number): Buffer {
    this.buffered -= n;
    const first = this.chunks[0]!;
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift(); else this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    for (let at = 0; at < n;) {
      const c = this.chunks[0]!;
      const k = Math.min(c.length, n - at);
      c.copy(out, at, 0, k);
      at += k;
      if (k === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(k);
    }
    return out;
  }
}

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** An ISO 639 language code, as Whisper takes it (the same rule as routes.ts `LANG`; that file is not imported, to keep the host small). */
const LANG = /^[a-z]{2,3}$/;

/** The request a header holds. Throws a WireError for an unknown type or a field the host cannot use: the connection ends. */
export function parseRequest(h: Header): HostRequest {
  const bad = (what: string) => new WireError(`bad ${what}`);
  switch (h.type) {
    case 'hello':
      if (typeof h.proto !== 'number' || !Number.isInteger(h.proto)) throw bad('hello');
      if ((h.nonce !== undefined && (typeof h.nonce !== 'string' || !HEX32.test(h.nonce))) || (h.proof !== undefined && typeof h.proof !== 'string')) throw bad('hello');
      return { type: 'hello', proto: h.proto, ...(h.nonce !== undefined ? { nonce: h.nonce } : {}), ...(h.proof !== undefined ? { proof: h.proof as string } : {}) };
    case 'status':
      return { type: 'status' };
    case 'job': {
      const o = h.opts as { lang?: unknown; detect?: unknown } | null | undefined;
      if (!isId(h.id) || !o || typeof o !== 'object' || typeof o.lang !== 'string' || !LANG.test(o.lang) || (o.detect !== undefined && typeof o.detect !== 'boolean')) throw bad('job');
      return { type: 'job', id: h.id, opts: { lang: o.lang, detect: o.detect === true } };
    }
    case 'cancel':
      if (!isId(h.id)) throw bad('cancel');
      return { type: 'cancel', id: h.id };
    case 'shutdown':
      if (h.reason !== undefined && typeof h.reason !== 'string') throw bad('shutdown');
      return { type: 'shutdown', reason: (h.reason ?? 'shutdown').slice(0, 64) };
    default:
      throw new WireError(`unknown message type ${JSON.stringify(h.type)?.slice(0, 40)}`);
  }
}

/** Samples as the wire carries them: 16-bit little-endian PCM, clipped to the range. */
export function pcmToInt16(pcm: Float32Array): Uint8Array {
  const s = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) s[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i]! * 32768)));
  return new Uint8Array(s.buffer);
}

/** The samples of a PCM body, as Whisper takes them (the inverse of pcmToInt16 up to rounding). */
export function pcmFromInt16(body: Uint8Array): Float32Array {
  if (body.length % 2) throw new WireError('a PCM body has an even number of bytes');
  const at = body.byteOffset;
  // little-endian, as every machine Nota Bene runs on; a view when aligned, else a copy
  const s = at % 2 === 0 ? new Int16Array(body.buffer, at, body.length >> 1) : new Int16Array(body.buffer.slice(at, at + body.length));
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i]! / 32768;
  return out;
}
