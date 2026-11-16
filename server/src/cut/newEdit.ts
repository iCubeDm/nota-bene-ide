// `POST /cut/new {dir, cut}` (issue 426): a new edit written beside the files it was made from, under the first free name
// (`edit.nbcut.json`, `edit 2.nbcut.json`, ...). Never over a file: the name is taken with an exclusive create, so a file
// that appears meanwhile moves it on to the next name. The edit must be valid as the editor would write it.
import fs from 'node:fs';
import path from 'node:path';
import { uniqueCutName, validateCut } from '@nota-bene/shared/cut';
import { resolveInRoot } from '../files.ts';

export type NewEditAnswer = { status: number; body: Record<string, unknown> };

/** What the disk refused, said by its code alone: the answer never carries an absolute path. */
const WRITE_CODES: Record<string, number> = { EACCES: 403, EPERM: 403, EROFS: 403, ENOSPC: 507, EDQUOT: 507 };
const refused = (e: unknown): NewEditAnswer | null => {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code && code in WRITE_CODES ? { status: WRITE_CODES[code]!, body: { error: 'cannot-write', code } } : null;
};

/** How many taken names a create tries past before it gives up (a folder of thousands of edits named so). */
const TRIES = 1000;

/** `cut` written in the project folder `dir` ('' the root); answers the new edit's project-relative path. */
export async function createEdit(root: string, dir: string, cut: unknown): Promise<NewEditAnswer> {
  const check = validateCut(cut);
  if (!check.ok) return { status: 422, body: { error: 'bad-edit', issues: check.errors } };
  const abs = dir === '' ? path.resolve(root) : resolveInRoot(root, dir);
  if (abs === null) return { status: 403, body: { error: 'outside-project' } };
  const st = await fs.promises.stat(abs).catch(() => null);
  if (!st?.isDirectory()) return { status: 404, body: { error: 'not-found' } };
  // the editor's own form of the file (useCutDoc serialize)
  const text = `${JSON.stringify(check.cut, null, 2)}\n`;
  let names: string[];
  try {
    names = await fs.promises.readdir(abs);
  } catch (e) {
    const no = refused(e);
    if (no) return no;
    throw e;
  }
  for (let i = 0; i < TRIES; i++) {
    const name = uniqueCutName(names);
    const file = path.join(abs, name);
    try {
      await fs.promises.writeFile(file, text, { flag: 'wx' });
      // the project-relative path as the page names files: `/` between the parts
      return { status: 201, body: { path: path.relative(path.resolve(root), file).split(path.sep).join('/') } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        const no = refused(e);
        if (no) return no;
        throw e;
      }
      names.push(name);
    }
  }
  return { status: 409, body: { error: 'no-free-name' } };
}
