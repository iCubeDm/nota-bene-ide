import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EDIT_MAX, readEditable, writeEditable } from './fileEdit.ts';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-edit-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const put = (name: string, data: string | Buffer) => { fs.writeFileSync(path.join(root, name), data); };
const got = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');
const baseOf = async (name: string) => (await readEditable(root, name)).body.base as string;

describe('readEditable', () => {
  it('the text and its version; the version follows the content', async () => {
    put('a.md', 'one');
    const a = await readEditable(root, 'a.md');
    expect(a).toMatchObject({ status: 200, body: { text: 'one' } });
    put('a.md', 'two');
    expect(await baseOf('a.md')).not.toBe(a.body.base);
  });

  it('refuses what is no text, too large, missing, or outside', async () => {
    put('nul.bin', Buffer.from([65, 0, 66]));
    put('latin.txt', Buffer.from([0xe9]));
    put('big.txt', 'x'.repeat(EDIT_MAX + 1));
    fs.mkdirSync(path.join(root, 'dir'));
    expect((await readEditable(root, 'nul.bin')).status).toBe(415);
    expect((await readEditable(root, 'latin.txt')).status).toBe(415);
    expect((await readEditable(root, 'big.txt')).status).toBe(413);
    expect((await readEditable(root, 'none.txt')).status).toBe(404);
    expect((await readEditable(root, 'dir')).status).toBe(404);
    expect((await readEditable(root, '../x')).status).toBe(403);
    expect((await readEditable(root, '')).status).toBe(403);
  });
});

describe('writeEditable', () => {
  it('writes, leaves no temp file, and answers the new version', async () => {
    put('a.md', 'one');
    const r = await writeEditable(root, 'a.md', 'two', await baseOf('a.md'));
    expect(r.status).toBe(200);
    expect(got('a.md')).toBe('two');
    expect(fs.readdirSync(root)).toEqual(['a.md']);
    expect(r.body.base).toBe(await baseOf('a.md'));
  });

  it('a change the editor has not seen is a 409 and stays; null overwrites it', async () => {
    put('a.md', 'one');
    const base = await baseOf('a.md');
    put('a.md', 'the agent wrote this');
    expect((await writeEditable(root, 'a.md', 'mine', base)).status).toBe(409);
    expect(got('a.md')).toBe('the agent wrote this');
    expect((await writeEditable(root, 'a.md', 'mine', null)).status).toBe(200);
    expect(got('a.md')).toBe('mine');
  });

  it('keeps the mode; a read-only file is refused and stays', async () => {
    put('run.sh', 'a');
    fs.chmodSync(path.join(root, 'run.sh'), 0o750);
    await writeEditable(root, 'run.sh', 'b', null);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(root, 'run.sh')).mode & 0o777).toBe(0o750); // no mode bits on Windows
    put('ro.txt', 'a');
    fs.chmodSync(path.join(root, 'ro.txt'), 0o444);
    expect(await writeEditable(root, 'ro.txt', 'b', null)).toMatchObject({ status: 403, body: { error: 'read-only' } });
    expect(got('ro.txt')).toBe('a');
  });

  it('keeps the line ends the file mostly has, and its BOM', async () => {
    put('win.txt', '﻿a\r\nb\r\n');
    const { text } = (await readEditable(root, 'win.txt')).body as { text: string };
    expect(text.startsWith('﻿')).toBe(true);
    await writeEditable(root, 'win.txt', text.replace(/\r\n/g, '\n').replace('b', 'c'), null);
    expect(got('win.txt')).toBe('﻿a\r\nc\r\n');
    put('unix.txt', 'a\nb\n');
    await writeEditable(root, 'unix.txt', 'a\nc\n', null);
    expect(got('unix.txt')).toBe('a\nc\n');
  });

  it('through a symlink the target changes and the link stays; a link out of the project is refused', async () => {
    put('real.txt', 'a');
    fs.symlinkSync('real.txt', path.join(root, 'link.txt'));
    await writeEditable(root, 'link.txt', 'b', null);
    expect(fs.lstatSync(path.join(root, 'link.txt')).isSymbolicLink()).toBe(true);
    expect(got('real.txt')).toBe('b');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-out-'));
    fs.writeFileSync(path.join(out, 'x'), 'secret');
    fs.symlinkSync(path.join(out, 'x'), path.join(root, 'away'));
    expect((await writeEditable(root, 'away', 'b', null)).status).toBe(403);
    expect(fs.readFileSync(path.join(out, 'x'), 'utf8')).toBe('secret');
    fs.rmSync(out, { recursive: true });
  });

  it('too large a text is refused; the file stays', async () => {
    put('a.txt', 'a');
    expect((await writeEditable(root, 'a.txt', 'x'.repeat(EDIT_MAX + 1), null)).status).toBe(413);
    expect(got('a.txt')).toBe('a');
  });

  it('a missing file is not created', async () => {
    expect((await writeEditable(root, 'new.txt', 'a', null)).status).toBe(404);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
