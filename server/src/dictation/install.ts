// The optional "Whisper on the host" install: transformers.js plus one ONNX model, under <stateBase>/whisper/. Same shape as the
// runtime store's release install (runtime.ts): a lock, a log, an npm timeout. `ready.json` is written last and names the pins,
// so a folder from other pins reads as not installed.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultNpm, NPM_TIMEOUT_MS, readLock, run, takeLockFile } from '../runtime.ts';
import { stateBaseDir } from '../state.ts';
import { WHISPER_DTYPE, WHISPER_MODEL, WHISPER_PACKAGE, WHISPER_REVISION, WHISPER_VERSION } from './whisper.ts';

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

export function whisperPhase(): WhisperPhase {
  const l = readLock(lockFile());
  if (l && l !== 'stale') {
    let age = 0;
    try { age = Date.now() - fs.statSync(lockFile()).mtimeMs; } catch { /* gone a moment ago */ }
    // a lock past the npm timeout is a dead install whose pid was reused
    return age > NPM_TIMEOUT_MS ? 'failed' : 'installing';
  }
  if (isReady()) return 'ready';
  return l === 'stale' || fs.existsSync(failedFile()) ? 'failed' : 'none';
}

/** Loads the pipeline once from the installed prefix, which downloads the pinned model into <dir>/models. */
async function defaultFetchModel(dir: string): Promise<void> {
  const resolved = createRequire(path.join(dir, 'package.json')).resolve(WHISPER_PACKAGE);
  const mod = await import(pathToFileURL(resolved).href) as { pipeline?: unknown; env?: { cacheDir: string }; default?: { pipeline?: unknown; env?: { cacheDir: string } } };
  const api = mod.pipeline ? mod : mod.default;
  if (!api?.pipeline || !api.env) throw new Error(`${WHISPER_PACKAGE} has no pipeline`);
  api.env.cacheDir = path.join(dir, 'models');
  const pipe = await (api.pipeline as (task: string, model: string, o: object) => Promise<{ dispose?: () => Promise<void> }>)(
    'automatic-speech-recognition', WHISPER_MODEL, { revision: WHISPER_REVISION, dtype: WHISPER_DTYPE });
  await pipe.dispose?.();
}

/** Installs the pinned package and model. Takes the lock synchronously, so a second call right after sees `installing`. Rejects on failure. */
export function installWhisper(o: { spawn?: Run; npm?: string | null; fetchModel?: (dir: string) => Promise<void> } = {}): Promise<void> {
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
        const got = await (o.spawn ?? run)(npm, ['install', '--prefix', dir, `${WHISPER_PACKAGE}@${WHISPER_VERSION}`, '--no-audit', '--no-fund'], log, NPM_TIMEOUT_MS);
        if (got.timedOut) throw new Error('npm timed out');
        if (got.code !== 0) throw new Error(`npm install exited with ${got.code}`);
      } finally { fs.closeSync(log); }
      await (o.fetchModel ?? defaultFetchModel)(dir);
      fs.writeFileSync(readyFile(), JSON.stringify({ version: WHISPER_VERSION, model: WHISPER_MODEL, revision: WHISPER_REVISION }), { mode: 0o600 });
    } catch (e) {
      try { fs.writeFileSync(failedFile(), JSON.stringify({ at: Date.now(), reason: e instanceof Error ? e.message : String(e) }), { mode: 0o600 }); } catch { /* best effort */ }
      throw e;
    } finally {
      fs.rmSync(lockFile(), { force: true });
    }
  })();
}

/** Deletes the install (never while one runs). Returns false when refused. */
export function removeWhisper(): boolean {
  if (whisperPhase() === 'installing') return false;
  fs.rmSync(whisperDir(), { recursive: true, force: true });
  return true;
}
