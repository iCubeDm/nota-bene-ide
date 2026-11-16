import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Cut } from '@nota-bene/shared/cut';
import { createEdit } from './newEdit.ts';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-cut-new-'));
  fs.mkdirSync(path.join(root, 'media'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const cut: Cut = {
  version: 1, width: 1920, height: 1080, fps: 30,
  tracks: [{ id: 'v1', kind: 'video' }],
  clips: [{ id: 'c1', track: 'v1', src: 'media/a.mp4', at: 0, out: 3 }],
};

describe('createEdit (issue 426): a new edit beside the files', () => {
  it('writes edit.nbcut.json in the folder, then edit 2.nbcut.json, never over a file', async () => {
    const a = await createEdit(root, 'media', cut);
    expect(a).toEqual({ status: 201, body: { path: 'media/edit.nbcut.json' } });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'media/edit.nbcut.json'), 'utf8'))).toEqual(cut);
    expect(fs.readFileSync(path.join(root, 'media/edit.nbcut.json'), 'utf8')).toBe(`${JSON.stringify(cut, null, 2)}\n`);
    expect((await createEdit(root, 'media', cut)).body).toEqual({ path: 'media/edit 2.nbcut.json' });
    // the project root itself
    expect((await createEdit(root, '', cut)).body).toEqual({ path: 'edit.nbcut.json' });
  });

  it('refuses an edit that is not valid (422), a folder outside the project (403) or not there (404)', async () => {
    const bad = await createEdit(root, 'media', { ...cut, fps: 0 });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('bad-edit');
    expect((await createEdit(root, '../x', cut)).status).toBe(403);
    expect((await createEdit(root, '/etc', cut)).status).toBe(403);
    expect((await createEdit(root, 'nope', cut)).status).toBe(404);
    fs.writeFileSync(path.join(root, 'file.txt'), '');
    expect((await createEdit(root, 'file.txt', cut)).status).toBe(404);
    expect(fs.readdirSync(path.join(root, 'media'))).toEqual([]);
  });

  it('a folder that is a symlink out of the project is refused (403), nothing is written there', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-cut-out-'));
    try {
      fs.symlinkSync(out, path.join(root, 'link'));
      expect((await createEdit(root, 'link', cut)).status).toBe(403);
      expect((await createEdit(root, 'link/', cut)).status).toBe(403);
      expect(fs.readdirSync(out)).toEqual([]);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  it('the path answered is relative to the project with / (a dir given with ./ or a trailing slash)', async () => {
    fs.mkdirSync(path.join(root, 'media/sub'));
    expect((await createEdit(root, './media//sub/', cut)).body).toEqual({ path: 'media/sub/edit.nbcut.json' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a folder it cannot write to answers the code, never an absolute path', async () => {
    fs.chmodSync(path.join(root, 'media'), 0o555);
    try {
      const a = await createEdit(root, 'media', cut);
      expect(a).toEqual({ status: 403, body: { error: 'cannot-write', code: 'EACCES' } });
      expect(JSON.stringify(a)).not.toContain(root);
    } finally {
      fs.chmodSync(path.join(root, 'media'), 0o755);
    }
  });
});
