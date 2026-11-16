// `POST /cut/new {dir, cut}` (issue 426): a new edit written beside the files it was made from, under the first free name
// (`edit.nbcut.json`, `edit 2.nbcut.json`, ...). Never over a file: the name is taken with an exclusive create, so a file
// that appears meanwhile moves it on to the next name. The edit must be valid as the editor would write it.
import fs from 'node:fs';
import path from 'node:path';
import { uniqueCutName, validateCut } from '@nota-bene/shared/cut';
import { resolveInRoot } from '../files.ts';

export type NewEditAnswer = { status: number; body: Record<string, unknown> };

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
  const names = await fs.promises.readdir(abs);
  for (let i = 0; i < TRIES; i++) {
    const name = uniqueCutName(names);
    try {
      await fs.promises.writeFile(path.join(abs, name), text, { flag: 'wx' });
      return { status: 201, body: { path: dir === '' ? name : `${dir.replace(/\/+$/, '')}/${name}` } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      names.push(name);
    }
  }
  return { status: 409, body: { error: 'no-free-name' } };
}
