// `/edit`: a project file by hand. Text only, this checkout only, and never over a change the editor has not seen.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInRoot } from './files.ts';
import { renameRetry } from './platform.ts';

/** What the viewer shows as text. */
export const EDIT_MAX = 2 * 1024 * 1024;

export type EditAnswer = { status: number; body: Record<string, unknown> };
const refuse = (status: number, error: string): EditAnswer => ({ status, body: { error } });

const hashOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The text of `bytes`; null when they are no text. The BOM stays: it is the file's, and a save must not drop it. */
function decode(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The real file behind `rel`, or why not. The real path: a save through a symlink replaces its target, not the link. */
async function target(root: string, rel: string): Promise<{ file: string; st: fs.Stats } | EditAnswer> {
  const abs = resolveInRoot(root, rel);
  if (abs === null || rel === '') return refuse(403, 'outside project');
  const st = await fs.promises.stat(abs).catch(() => null);
  if (!st?.isFile()) return refuse(404, 'not found');
  if (st.size > EDIT_MAX) return refuse(413, 'too large');
  return { file: await fs.promises.realpath(abs), st };
}

export async function readEditable(root: string, rel: string): Promise<EditAnswer> {
  const t = await target(root, rel);
  if ('status' in t) return t;
  const bytes = await fs.promises.readFile(t.file);
  const text = decode(bytes);
  if (text === null) return refuse(415, 'not text');
  return { status: 200, body: { text, base: hashOf(bytes) } };
}

/** A browser's text box has only `\n`: the file keeps the line ends it mostly has. */
function withLineEnds(text: string, was: string): string {
  const crlf = was.match(/\r\n/g)?.length ?? 0;
  const lf = (was.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? text.replace(/\r?\n/g, '\r\n') : text;
}

/**
 * Whole or not at all: a temp file beside it, renamed over. `base`: the version the editor started from, a different one on
 * disk is a 409 and nothing is written; null overwrites what is there. A rename ignores the file's own mode, so a read-only
 * file is refused first.
 */
export async function writeEditable(root: string, rel: string, text: string, base: string | null): Promise<EditAnswer> {
  const t = await target(root, rel);
  if ('status' in t) return t;
  const was = await fs.promises.readFile(t.file);
  const old = decode(was);
  if (old === null) return refuse(415, 'not text');
  if (base !== null && base !== hashOf(was)) return refuse(409, 'changed');
  try {
    await fs.promises.access(t.file, fs.constants.W_OK);
  } catch {
    return refuse(403, 'read-only');
  }
  const bytes = Buffer.from(withLineEnds(text, old), 'utf8');
  if (bytes.length > EDIT_MAX) return refuse(413, 'too large');
  const tmp = path.join(path.dirname(t.file), `.${path.basename(t.file)}.${randomBytes(6).toString('hex')}.nb-tmp`);
  try {
    await fs.promises.writeFile(tmp, bytes, { flag: 'wx', mode: t.st.mode & 0o777 });
    await fs.promises.chmod(tmp, t.st.mode & 0o777); // the mode above went through the umask
    renameRetry(tmp, t.file); // sync: Windows retries a rename over a file another process holds open
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return { status: 200, body: { base: hashOf(bytes) } };
}
