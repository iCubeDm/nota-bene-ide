// The window's side of remote access: one `nota-bene remote` per user, kept running while a relay is saved and access is on.
// Every window asks the connector's control socket for its status every few seconds; when nobody answers, it starts one
// (`--managed`, detached, under remote/spawn.lock so that windows finding nobody together start one), as the Whisper host
// is started (dictation/hostClient.ts). A managed connector exits a minute after the last window (connector.ts); one
// started by hand in a terminal is reused as it is. The state goes to the page as the `remote` event, the routes act
// through the same socket (routes.ts).
import { spawn as spawnChild } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { RemoteDevice, RemotePairResult, RemoteState } from '@nota-bene/shared';
import { renderSVG } from 'uqr';
import { HIDDEN, renameRetry } from '../platform.ts';
import { stateBaseDir } from '../state.ts';
import { readLock, takeLockFile } from '../runtime.ts';
import { controlClient, running, type ControlClient, type Msg } from './control.ts';
import {
  checkRelay, clearLastError, fingerprint, fromB64u, parseAccessKey, readAccessKey, readConfig, readDevices, readLastError, remoteDir, writeAccessKey, writeConfig,
  type RemoteConfig,
} from './store.ts';

/** A readable access key is saved. Nothing is created to find out; a broken file (mode, owner) counts as none, so the tab
 * asks for the key again, and saving it rewrites the file. */
function hasAccessKey(): boolean {
  if (!fs.existsSync(path.join(stateBaseDir(), 'remote', 'access-key'))) return false;
  try {
    return readAccessKey() !== null;
  } catch {
    return false;
  }
}

/** How often a window looks at the connector. */
export const ENSURE_MS = 5000;
/** How long a window waits for a connector it started (or another window is starting) to answer. */
export const SPAWN_WAIT_MS = 10_000;
/** After failed starts in a row (or a relay refusal), the next attempt waits this long: 1, 2, 5, then every 10 minutes. */
export const BACKOFF_MS = [60_000, 120_000, 300_000, 600_000];
const ASK_MS = 2000;
const POLL_MS = 50;

/** The connector answers, but it predates the window's switches (started in a terminal by an older version). */
export class LegacyConnector extends Error {
  constructor() { super('nota-bene remote was started in a terminal by an older version; restart it there'); }
}
export class NotRunning extends Error {
  constructor() { super('nota-bene remote is not running'); }
}

export type PairCode = { uri: string; qr: string; hostFingerprint: string; expiresAt: number };
export type PairOutcome = { result: RemotePairResult; device?: RemoteDevice; fingerprint?: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `a` is an older release than `b` (x.y.z; a pre-release before its release). Anything else is not older: left alone. */
export function olderVersion(a: unknown, b: string): boolean {
  const parse = (v: unknown) => {
    const m = typeof v === 'string' ? /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v) : null;
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i]! < y.n[i]!;
  return x.pre !== null && (y.pre === null || x.pre < y.pre);
}

/** What a detached connector gets: what it needs to find this user's state, and nothing of the window's secrets. */
function connectorEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'NOTA_BENE_HOME', 'NOTA_BENE_ALLOW_SHARED_HOME',
    ...(process.platform === 'win32' ? ['SystemRoot', 'windir', 'USERPROFILE', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA'] : [])];
  return Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
}

function device(d: Msg): RemoteDevice {
  return {
    id: String(d.id), ...(typeof d.name === 'string' ? { name: d.name } : {}), fingerprint: String(d.fingerprint),
    online: d.online === true, pairedAt: typeof d.pairedAt === 'number' ? d.pairedAt : 0,
  };
}

export type KeeperOptions = {
  /** the package's version: a managed connector of another one is replaced */
  version?: string;
  /** the launcher to start (`<package>/bin/nota-bene.mjs`); the default `spawn` needs it */
  entry?: string;
  /** starts a connector (tests start one in-process) */
  spawn?: () => void;
  pollMs?: number;
  spawnWaitMs?: number;
  now?: () => number;
};

/** Events: `state(RemoteState)` when it changes, `pair(PairOutcome)` for the pairing this window started, `warn(message)`. */
export class RemoteKeeper extends EventEmitter {
  #o: KeeperOptions & { pollMs: number; spawnWaitMs: number; now: () => number };
  #timer: NodeJS.Timeout | undefined;
  #pass: Promise<RemoteState> | undefined;
  #state: RemoteState = {
    configured: false, enabled: true, running: false, online: false, relay: null, hostFingerprint: null, devices: [],
    pairing: null, legacy: false, lastError: null, startFailed: false, accessKey: false,
  };
  #last = '';
  #warned = '';
  #failures = 0;
  #retryAt = 0;
  #startFailed = false;
  #wasRunning = false;
  #pairClient: ControlClient | undefined;
  #stopped = false;

  constructor(o: KeeperOptions = {}) {
    super();
    this.#o = { ...o, pollMs: o.pollMs ?? ENSURE_MS, spawnWaitMs: o.spawnWaitMs ?? SPAWN_WAIT_MS, now: o.now ?? Date.now };
  }

  start(): void {
    this.#stopped = false;
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.#o.pollMs);
    this.#timer.unref();
  }

  /** Stops looking; the connector goes on (it serves the other windows, and exits by itself after the last one). */
  stop(): void {
    this.#stopped = true; // a pass still under way starts nothing now
    clearInterval(this.#timer);
    this.#pairClient?.close();
    this.#pairClient = undefined;
  }

  state(): RemoteState {
    return this.#state;
  }

  /** One pass now: ask, start the connector if it should run, and compute the state (concurrent calls share a pass). */
  refresh(): Promise<RemoteState> {
    this.#pass ??= this.#ensure().finally(() => (this.#pass = undefined));
    return this.#pass;
  }

  /**
   * Saves the relay, the switch and the access key, then acts on them: off, or another relay, stops the running connector
   * (a managed one comes back for the new relay); a new access key makes it reconnect with it. `stopped` says whose
   * connector was stopped: a terminal's (`hand`) is worth telling.
   */
  async setConfig(c: RemoteConfig & { accessKey?: string | null }): Promise<{ state: RemoteState; stopped: 'hand' | 'managed' | null }> {
    const { accessKey, ...cfg } = c;
    if (cfg.relay !== undefined) checkRelay(cfg.relay);
    if (typeof accessKey === 'string') parseAccessKey(accessKey);
    await this.#pass;
    const st = await this.#ask({ op: 'status' });
    const replace = !!st && (cfg.enabled === false || (cfg.relay !== undefined && cfg.relay !== st.relay));
    // a connector from before access keys neither reads nor reconnects with one
    if ((replace || (accessKey !== undefined && !!st)) && st!.version === undefined) throw new LegacyConnector();
    if (Object.keys(cfg).length) writeConfig({ ...readConfig(), ...cfg });
    if (accessKey !== undefined) writeAccessKey(accessKey);
    clearLastError();
    this.#failures = 0;
    this.#retryAt = 0;
    this.#startFailed = false;
    let stopped: 'hand' | 'managed' | null = null;
    if (replace) {
      await this.#stopConnector();
      stopped = st.managed === true ? 'managed' : 'hand';
    } else if (accessKey !== undefined && st) {
      // a connector of the release before access keys has a version but neither reads the key nor knows `reconnect`
      const r = await this.#ask({ op: 'reconnect' });
      if (r?.ok !== true) {
        // stopped, as the switch stops it: a window's connector of this version comes up with the key
        await this.#stopConnector();
        stopped = st.managed === true ? 'managed' : 'hand';
      }
    }
    return { state: await this.refresh(), stopped };
  }

  /** Starts a pairing (a running one of this window is replaced). Its outcome comes as `pair`. */
  async pair(): Promise<PairCode> {
    this.cancelPair();
    let cl: ControlClient;
    try {
      cl = await controlClient();
    } catch {
      throw new NotRunning();
    }
    let code: Msg;
    try {
      cl.send({ op: 'pair' });
      code = await cl.next((m) => m.t === 'code', ASK_MS);
    } catch (e) {
      cl.close();
      throw e;
    }
    this.#pairClient = cl;
    void this.#follow(cl);
    void this.refresh();
    const uri = String(code.uri);
    // dark on its own white in every theme, with a quiet zone a phone camera finds
    return { uri, qr: renderSVG(uri, { border: 2 }), hostFingerprint: String(code.hostFingerprint), expiresAt: Number(code.expiresAt) };
  }

  /** Withdraws this window's code (the connector ends a pairing whose client went). */
  cancelPair(): void {
    const cl = this.#pairClient;
    if (!cl) return;
    this.#pairClient = undefined;
    cl.close();
    void this.refresh();
  }

  async revoke(id: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.#ask({ op: 'revoke', id });
    if (!r) throw new NotRunning();
    void this.refresh();
    return r.ok === true ? { ok: true } : { ok: false, error: String(r.error) };
  }

  async #follow(cl: ControlClient): Promise<void> {
    try {
      for (;;) {
        const m = await cl.next((x) => x.t !== 'code', 24 * 3600_000);
        if (this.#pairClient !== cl) return;
        if (m.t === 'refused') this.emit('pair', { result: 'refused', fingerprint: String(m.fingerprint) } satisfies PairOutcome);
        else if (m.t === 'paired' || m.t === 'expired' || m.t === 'cancelled') {
          this.emit('pair', { result: m.t, ...(m.t === 'paired' ? { device: device(m.device as Msg) } : {}) } satisfies PairOutcome);
          this.#pairClient = undefined;
          cl.close();
          void this.refresh();
          return;
        } else if (m.t === 'error') this.#warn(`pairing: ${String(m.message)}`);
      }
    } catch {
      // the connector went (or this window cancelled): the code is over
      if (this.#pairClient === cl) {
        this.#pairClient = undefined;
        this.emit('pair', { result: 'cancelled' } satisfies PairOutcome);
        void this.refresh();
      }
    }
  }

  /** One message to the connector and its answer; null when none runs. */
  async #ask(m: Msg): Promise<Msg | null> {
    let cl: ControlClient;
    try {
      cl = await controlClient();
    } catch {
      return null;
    }
    try {
      cl.send(m);
      return await cl.next(undefined, ASK_MS);
    } catch {
      return null;
    } finally {
      cl.close();
    }
  }

  async #stopConnector(): Promise<void> {
    await this.#ask({ op: 'stop' });
    const until = Date.now() + this.#o.spawnWaitMs;
    while (await running()) {
      if (Date.now() >= until) throw new Error('nota-bene remote did not stop');
      await sleep(POLL_MS);
    }
  }

  #backOff(): void {
    this.#failures++;
    this.#retryAt = this.#o.now() + BACKOFF_MS[Math.min(this.#failures - 1, BACKOFF_MS.length - 1)]!;
  }

  async #ensure(): Promise<RemoteState> {
    let cfg: RemoteConfig = {};
    try {
      // never set up: nothing to ask, and nothing is created (remote/, and on Windows the pipe's secret) by asking.
      // A connector needs a saved relay, so none runs without this file.
      if (!fs.existsSync(path.join(stateBaseDir(), 'remote', 'config.json'))) {
        this.#wasRunning = false;
        this.#publish(this.#compute(cfg, null, []));
        return this.#state;
      }
      cfg = readConfig();
      let st = await this.#ask({ op: 'status' });
      // a managed connector of an older version (the package was updated): replaced by one of this version. Only older: a
      // window of the previous release still open must not replace the new one back, every few seconds
      if (st && st.managed === true && this.#o.version && olderVersion(st.version, this.#o.version)) {
        await this.#stopConnector();
        st = null;
      }
      // it was running and it is gone, the relay's refusal left behind: it exited for good, so wait before the next one
      if (!st && this.#wasRunning && readLastError()) this.#backOff();
      if (!st && !this.#stopped && cfg.relay && cfg.enabled !== false && this.#o.now() >= this.#retryAt) {
        if (await this.#start()) {
          st = await this.#ask({ op: 'status' });
          this.#failures = 0;
          this.#startFailed = false;
        } else {
          this.#backOff();
          this.#startFailed = !readLastError();
        }
      }
      this.#wasRunning = !!st;
      this.#publish(this.#compute(cfg, st));
    } catch (e) {
      this.#warn((e as Error).message);
    }
    return this.#state;
  }

  #compute(cfg: RemoteConfig, st: Msg | null, none?: []): RemoteState {
    const pairing = st?.pairing as { expiresAt?: unknown } | null | undefined;
    const devices = none ?? (st
      ? ((st.devices as Msg[]) ?? []).map(device)
      : readDevices().map((d) => ({ id: d.id, ...(d.name ? { name: d.name } : {}), fingerprint: fingerprint(fromB64u(d.pub, 32)), online: false, pairedAt: d.addedAt })));
    return {
      configured: !!cfg.relay,
      enabled: cfg.enabled !== false,
      running: !!st,
      online: st?.online === true,
      relay: typeof st?.relay === 'string' ? st.relay : cfg.relay ?? null,
      hostFingerprint: typeof st?.hostFingerprint === 'string' ? st.hostFingerprint : null,
      devices,
      pairing: pairing && typeof pairing.expiresAt === 'number' ? { expiresAt: pairing.expiresAt, mine: !!this.#pairClient } : null,
      legacy: !!st && st.version === undefined,
      lastError: none ? null : readLastError(),
      startFailed: this.#startFailed,
      accessKey: hasAccessKey(),
    };
  }

  #publish(s: RemoteState): void {
    this.#state = s;
    const j = JSON.stringify(s);
    if (j === this.#last) return;
    this.#last = j;
    this.emit('state', s);
  }

  #warn(m: string): void {
    if (m === this.#warned) return; // once per message, not every few seconds
    this.#warned = m;
    this.emit('warn', m);
  }

  /** Nobody answers: start a connector under the spawn lock and wait for it. True once one answers. */
  async #start(): Promise<boolean> {
    const lock = path.join(remoteDir(), 'spawn.lock');
    const token = `remote.${process.pid}.${randomBytes(6).toString('hex')}`;
    const until = Date.now() + this.#o.spawnWaitMs;
    while (!takeLockFile(lock, token)) {
      if (await running()) return true; // another window started it
      if (Date.now() >= until) return false;
      await sleep(POLL_MS);
    }
    try {
      if (await running()) return true;
      if (this.#stopped) return false; // the window is closing: the next window's pass starts one
      try {
        (this.#o.spawn ?? (() => this.#spawn()))();
      } catch (e) {
        this.#warn((e as Error).message);
        return false;
      }
      while (!(await running())) {
        if (Date.now() >= until) return false;
        await sleep(POLL_MS);
      }
      return true;
    } finally {
      const l = readLock(lock);
      if (l && l !== 'stale' && l.version === token) fs.rmSync(lock, { force: true });
    }
  }

  /** `nota-bene remote --managed`, detached; its output in remote/connector.log, the previous start's in connector.log.1. */
  #spawn(): void {
    const entry = this.#o.entry;
    if (!entry || !fs.existsSync(entry)) throw new Error(`there is no launcher to start nota-bene remote from (${entry ?? 'none given'})`);
    const dir = remoteDir();
    const logFile = path.join(dir, 'connector.log');
    try { renameRetry(logFile, `${logFile}.1`); } catch { /* the first start */ }
    const log = fs.openSync(logFile, 'w', 0o600);
    try {
      const child = spawnChild(process.execPath, [entry, 'remote', '--managed'], { detached: true, stdio: ['ignore', log, log], env: connectorEnv(), cwd: dir, ...HIDDEN });
      child.on('error', (e) => this.#warn(`nota-bene remote could not be started: ${e.message}`));
      child.unref();
    } finally {
      fs.closeSync(log);
    }
  }
}
