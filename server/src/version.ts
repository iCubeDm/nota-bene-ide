import fs from 'node:fs';
import path from 'node:path';

/** `version` of the package.json in `dir`, or undefined when there is none or it is unreadable. */
export function readVersion(dir: string): string | undefined {
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && v ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The root of the package that installs the `nota-bene` command, found upwards from `from`. Walking up rather than a fixed
 * `../..`: the published bundles sit at different depths (server/src/main.js, server/src/remote/cli.js, bin/nota-bene.mjs),
 * and every one of them inlines this file. The workspace package.json files on the way (server/) have no such `bin`.
 */
export function packageRoot(from: string): string | undefined {
  for (let dir = from; ; dir = path.dirname(dir)) {
    try {
      const bin = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { bin?: Record<string, unknown> }).bin;
      if (bin && typeof bin === 'object' && 'nota-bene' in bin) return dir;
    } catch { /* no package.json here */ }
    if (path.dirname(dir) === dir) return undefined;
  }
}

let cached: { v: string | undefined } | undefined;
/** Nota Bene's version (root package.json, the single place a release bumps), read once per process. */
export function packageVersion(): string | undefined {
  if (!cached) {
    const root = packageRoot(import.meta.dirname);
    cached = { v: root ? readVersion(root) : undefined };
  }
  return cached.v;
}
