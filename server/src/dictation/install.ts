// The optional "Whisper on the host" install: transformers.js plus one ONNX model, under <stateBase>/whisper/. Same shape as the
// runtime store's release install (runtime.ts): a lock, a log, an npm timeout. `ready.json` is written last and names the pins,
// so a folder from other pins reads as not installed.
import fs from 'node:fs';
import path from 'node:path';
import { defaultNpm, NPM_TIMEOUT_MS, readLock, run, takeLockFile } from '../runtime.ts';
import { dictationAssetDir, openPipeline, type Pipe, type WorkerFactory } from './pipelineHost.ts';
import { stateBaseDir } from '../state.ts';
import { FETCH_MODEL_TIMEOUT_MS, VERIFY_MODEL_TIMEOUT_MS, WHISPER_MODEL, WHISPER_PACKAGE, WHISPER_REVISION, WHISPER_VERSION } from './whisper.ts';

export type WhisperPhase = 'none' | 'installing' | 'ready' | 'failed';
type Run = typeof run;

export const whisperDir = (): string => path.join(stateBaseDir(), 'whisper');
const lockFile = () => path.join(whisperDir(), 'install.lock');
const readyFile = () => path.join(whisperDir(), 'ready.json');
const failedFile = () => path.join(whisperDir(), 'failed.json');

const isReady = (): boolean => {
  try {
    const r = JSON.parse(fs.readFileSync(readyFile(), 'utf8')) as { version?: unknown; model?: unknown; revision?: unknown };
    return r.version === WHISPER_VERSION && r.model === WHISPER_MODEL && r.revision === WHISPER_REVISION;
  } catch { return false; }
};

/**
 * One rule for "an install is running": the lock's pid is alive (takeLockFile judges the same way). No age limit: npm and the
 * model download each have their own timeout, so a live pid with an old lock is a slow install, not a dead one.
 */
export function whisperPhase(): WhisperPhase {
  const l = readLock(lockFile());
  if (l && l !== 'stale') return 'installing';
  if (isReady()) return 'ready';
  return l === 'stale' || fs.existsSync(failedFile()) ? 'failed' : 'none';
}

export type { Pipe };

/** Loads the ASR pipeline from the installed prefix, in a worker thread (never on the server's event loop). The first load downloads the pinned model into <dir>/models. */
export function loadPipeline(dir: string = whisperDir(), o: { worker?: WorkerFactory } = {}): Promise<Pipe> {
  return openPipeline(dir, o).ready;
}

/** Loads the model once in a worker that is ended afterwards; `signal` ends it early (the wait timed out). `download` is the one load that may fetch the model. */
async function loadOnce(dir: string, download: boolean, signal?: AbortSignal): Promise<void> {
  const h = openPipeline(dir, { download });
  const stop = () => h.close(new Error(download ? 'model download timed out' : 'model check timed out'));
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  try {
    const pipe = await h.ready;
    await pipe.dispose?.();
  } finally { signal?.removeEventListener('abort', stop); }
}

const defaultFetchModel = (dir: string, signal?: AbortSignal): Promise<void> => loadOnce(dir, true, signal);
/** Loads the downloaded model the way every window and host will, by its folder and offline. */
const defaultVerifyModel = (dir: string, signal?: AbortSignal): Promise<void> => loadOnce(dir, false, signal);

/** The package.json the lockfile belongs to: the root of npm-shrinkwrap.json is `nota-bene-whisper` with this one dependency. */
const prefixPackageJson = () => JSON.stringify({ name: 'nota-bene-whisper', version: '0.0.0', private: true, dependencies: { [WHISPER_PACKAGE]: WHISPER_VERSION } }, null, 2);

/** Installs the pinned package and model. Takes the lock synchronously, so a second call right after sees `installing`. Rejects on failure. */
export function installWhisper(o: {
  spawn?: Run;
  npm?: string | null;
  fetchModel?: (dir: string, signal?: AbortSignal) => Promise<void>;
  fetchTimeoutMs?: number;
  /** The check that what was downloaded loads offline, before `ready` is written (default: the real load, unless `fetchModel` is a test's own: its folder holds no real model). */
  verifyModel?: (dir: string, signal?: AbortSignal) => Promise<void>;
  verifyTimeoutMs?: number;
} = {}): Promise<void> {
  const dir = whisperDir();
  if (!takeLockFile(lockFile(), WHISPER_VERSION)) return Promise.reject(new Error('already installing'));
  return (async () => {
    try {
      fs.rmSync(failedFile(), { force: true });
      fs.rmSync(readyFile(), { force: true });
      const npm = o.npm === undefined ? defaultNpm() : o.npm;
      if (!npm) throw new Error('npm not found');
      const log = fs.openSync(path.join(dir, 'install.log'), 'a', 0o600);
      try {
        // the lockfile pins every transitive package by hash; --ignore-scripts because none of them needs a script on the CPU
        // path (onnxruntime-node's postinstall only fetches the CUDA provider on linux/x64, protobufjs's only checks its version)
        fs.writeFileSync(path.join(dir, 'package.json'), prefixPackageJson());
        fs.copyFileSync(path.join(dictationAssetDir(), 'npm-shrinkwrap.json'), path.join(dir, 'npm-shrinkwrap.json'));
        // the real path: npm ci reads a prefix reached through a symlink as a link root missing from the lockfile
        const got = await (o.spawn ?? run)(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', fs.realpathSync(dir)], log, NPM_TIMEOUT_MS);
        if (got.timedOut) throw new Error('npm timed out');
        if (got.code !== 0) throw new Error(`npm ci exited with ${got.code}`);
      } finally { fs.closeSync(log); }
      await withTimeout(o.fetchModel ?? defaultFetchModel, dir, o.fetchTimeoutMs ?? FETCH_MODEL_TIMEOUT_MS, 'model download timed out');
      // an install is ready only if the files it has load the way every window and host loads them (offline, by path): a download
      // that is incomplete or in a layout the load does not read fails here, as an install that failed, not later in every job
      const verify = o.verifyModel ?? (o.fetchModel ? undefined : defaultVerifyModel);
      if (verify) {
        try {
          await withTimeout(verify, dir, o.verifyTimeoutMs ?? VERIFY_MODEL_TIMEOUT_MS, 'model check timed out');
        } catch (e) {
          throw new Error(`the downloaded model does not load: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // a Remove or a cleanup under a running install must not end in a fake `ready`
      if (!fs.existsSync(path.join(dir, 'node_modules'))) throw new Error('the install folder lost node_modules');
      fs.writeFileSync(readyFile(), JSON.stringify({ version: WHISPER_VERSION, model: WHISPER_MODEL, revision: WHISPER_REVISION }), { mode: 0o600 });
    } catch (e) {
      try { fs.writeFileSync(failedFile(), JSON.stringify({ at: Date.now(), reason: e instanceof Error ? e.message : String(e) }), { mode: 0o600 }); } catch { /* best effort */ }
      throw e;
    } finally {
      fs.rmSync(lockFile(), { force: true });
    }
  })();
}

async function withTimeout(load: (dir: string, signal?: AbortSignal) => Promise<void>, dir: string, ms: number, timedOut: string): Promise<void> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new Error(timedOut)); }, ms); });
  const job = load(dir, ac.signal);
  job.catch(() => {}); // when the timeout wins, its late rejection is not unhandled
  try { await Promise.race([job, timeout]); } finally { clearTimeout(timer); }
}

/**
 * Makes the install read as not installed (`ready.json` goes), which is what Remove does first: from then on no window starts a host
 * or a load from files that are about to go. Refused (false) while a live process holds the install lock, as `removeWhisper` is.
 */
export function withdrawWhisper(): boolean {
  const l = readLock(lockFile());
  if (l && l !== 'stale') return false;
  fs.rmSync(readyFile(), { force: true });
  return true;
}

/** Deletes the install, never while a live process holds the install lock (this one included). Returns false when refused. */
export function removeWhisper(): boolean {
  const l = readLock(lockFile());
  if (l && l !== 'stale') return false;
  fs.rmSync(whisperDir(), { recursive: true, force: true });
  return true;
}
