// Finding ffmpeg for the video editor's export (epic 406) and asking it what a source holds.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HIDDEN } from '../platform.ts';

type Env = Record<string, string | undefined>;

const isExecutable = (p: string): boolean => {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** An env variable by name, ignoring case on Windows (`Path` there is the usual spelling of PATH). */
const envGet = (env: Env, name: string, platform: NodeJS.Platform): string | undefined => {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
};

/** Where an installer leaves ffmpeg when its folder is not on PATH (a launch from the Dock or a shortcut often has a short PATH). */
export function ffmpegPlaces(env: Env, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/snap/bin/ffmpeg'];
  const at = (v: string, ...rest: string[]) => {
    const base = envGet(env, v, platform);
    return base ? [path.win32.join(base, ...rest)] : [];
  };
  return [
    ...at('LOCALAPPDATA', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    ...at('USERPROFILE', 'scoop', 'shims', 'ffmpeg.exe'),
    ...at('ProgramData', 'chocolatey', 'bin', 'ffmpeg.exe'),
    ...at('ProgramFiles', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
  ];
}

/**
 * The ffmpeg binary: `NOTA_BENE_FFMPEG` when set (it is authoritative: a wrong path means "no ffmpeg", never a silent
 * fall-through to another one), else `ffmpeg` on PATH, else the usual Homebrew, Linux and Windows places. null = none.
 * Pure stat checks, nothing is spawned.
 */
export function findFfmpeg({ env = process.env, platform = process.platform, exists = isExecutable }: { env?: Env; platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {}): string | null {
  const own = env.NOTA_BENE_FFMPEG;
  if (own) return exists(own) ? own : null;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  for (const dir of (envGet(env, 'PATH', platform) ?? '').split(win ? ';' : ':')) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!d) continue;
    const bin = p.join(d, win ? 'ffmpeg.exe' : 'ffmpeg');
    if (exists(bin)) return bin;
  }
  return ffmpegPlaces(env, platform).find(exists) ?? null;
}

/** What a source holds, as far as the export needs to know. */
export type Probed = { video: boolean; audio: boolean };

/** The streams `ffmpeg -i <file>` names on stderr (it exits 1: no output was given). ffprobe is not needed. */
export function probeSource(stderr: string): Probed {
  const streams = stderr.split('\n').filter((l) => /^\s*Stream #\d+:\d+/.test(l));
  return { video: streams.some((l) => /: Video: /.test(l)), audio: streams.some((l) => /: Audio: /.test(l)) };
}

// the child gets no secrets from our environment (API keys, tokens): only what a program needs to start
export const ffmpegEnv = (): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'USER', 'SystemRoot', 'USERPROFILE']) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
};

/** Asks ffmpeg which streams `file` has (15 s at most). */
export function probe(ffmpeg: string, file: string): Promise<Probed> {
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-nostdin', '-i', file], { timeout: 15_000, env: ffmpegEnv(), maxBuffer: 1 << 20, ...HIDDEN }, (_err, _stdout, stderr) => {
      resolve(probeSource(String(stderr)));
    });
  });
}

/** The release in the first line of `ffmpeg -version` (`9.0.2`, `n4.3.1`, `4.3.6-0+deb11u1`); null for a git build (`N-…`) or no answer. */
export function ffmpegVersion(stdout: string): string | null {
  return /^ffmpeg version n?(\d+\.\d+(?:\.\d+)?)/.exec(stdout.split('\n', 1)[0]!.trim())?.[1] ?? null;
}

/** The export needs ffmpeg 4.4 or newer (`amix normalize`). An unknown version is given the benefit of the doubt. */
export function isOldFfmpeg(version: string | null): boolean {
  if (!version) return false;
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major < 4 || (major === 4 && minor < 4);
}

/** Asks `ffmpeg -version` (5 s at most); null when it does not answer with a release. Synchronous: the caller caches it per binary. */
export function readFfmpegVersion(ffmpeg: string): string | null {
  try {
    return ffmpegVersion(execFileSync(ffmpeg, ['-version'], { timeout: 5000, env: ffmpegEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 20, ...HIDDEN }));
  } catch {
    return null;
  }
}
