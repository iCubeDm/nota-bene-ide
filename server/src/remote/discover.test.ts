import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBackend } from '../agent/fake.ts';
import { registerWindow } from '../windows.ts';
import { infoAt } from '../servers.ts';
import { Windows } from './discover.ts';
import { launchServer } from '../testing.ts';

let tmp: string;
let home: string;
const prev = { home: process.env.NOTA_BENE_HOME, agent: process.env.NOTA_BENE_AGENT };
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-disc-')));
  home = path.join(tmp, 'home');
  for (const d of ['dist', 'a', 'b']) fs.mkdirSync(path.join(tmp, d));
  fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<h1>shell</h1>');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prev.home === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prev.home;
  if (prev.agent === undefined) delete process.env.NOTA_BENE_AGENT; else process.env.NOTA_BENE_AGENT = prev.agent;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** An in-process server started as `provider`, registered. */
async function window(provider: 'claude' | 'codex', dir: string) {
  process.env.NOTA_BENE_AGENT = provider;
  try {
    const s = await launchServer({ cwd: path.join(tmp, dir), port: 0, backend: fakeBackend([]), webDist: path.join(tmp, 'dist'), exit: () => {} });
    const port = Number(new URL(s.url).port);
    registerWindow(port, path.join(tmp, dir), process.pid);
    let open = true;
    const close = async () => {
      if (open) await s.close();
      open = false;
    };
    closers.push(close);
    return { port, close };
  } finally {
    process.env.NOTA_BENE_AGENT = 'claude';
  }
}

describe('window discovery', () => {
  it('lists the servers, whichever provider each started as, proved with the one token', async () => {
    const a = await window('claude', 'a');
    const b = await window('codex', 'b');
    const w = new Windows({ pollMs: 60_000 });
    await w.start();
    try {
      const list = w.list().map(({ port, root }) => ({ port, root }));
      expect(list).toEqual([{ port: a.port, root: path.join(tmp, 'a') }, { port: b.port, root: path.join(tmp, 'b') }].sort((x, y) => x.port - y.port));
      const info = await infoAt(b.port, '', w.get(b.port)!.bearer);
      expect(info?.root).toBe(path.join(tmp, 'b'));
      expect(w.get(a.port)!.bearer).toMatch(/^Bearer [0-9a-f]{64}$/);
    } finally {
      w.stop();
    }
  });

  it('does not list an entry whose port answers another token\'s proof', async () => {
    process.env.NOTA_BENE_HOME = path.join(tmp, 'other');
    const far = await window('claude', 'b');
    process.env.NOTA_BENE_HOME = home;
    const a = await window('claude', 'a');
    registerWindow(far.port, path.join(tmp, 'b'), process.pid); // filed here, but the port is another state folder's server
    const w = new Windows({ pollMs: 60_000 });
    await w.start();
    try {
      expect(w.list().map((x) => x.port)).toEqual([a.port]);
    } finally {
      w.stop();
    }
  });

  it('drops a window that stopped, and reports the change', async () => {
    const a = await window('claude', 'a');
    const b = await window('claude', 'b');
    const w = new Windows({ pollMs: 60_000 });
    const changes: number[][] = [];
    w.on('change', (l: { port: number }[]) => changes.push(l.map((x) => x.port)));
    await w.start();
    try {
      expect(w.list()).toHaveLength(2);
      await b.close();
      await w.refresh();
      expect(w.list().map((x) => x.port)).toEqual([a.port]);
      expect(changes.at(-1)).toEqual([a.port]);
      expect(await w.reprove(b.port)).toBeUndefined();
    } finally {
      w.stop();
    }
  });

  it('no token: nothing is listed, quietly, and none is made', async () => {
    registerWindow(4794, path.join(tmp, 'a'), process.pid);
    const w = new Windows({ pollMs: 60_000 });
    const warnings: string[] = [];
    w.on('warn', (m: string) => warnings.push(m));
    await w.start();
    w.stop();
    expect([w.list(), warnings, fs.existsSync(path.join(home, 'token'))]).toEqual([[], [], false]);
  });

  // no mode bits on Windows (the profile's ACL is trusted): there a token in place of a link is what is reported
  it.skipIf(process.platform === 'win32')('a loose token is reported, and nothing is listed', async () => {
    const a = await window('claude', 'a');
    fs.chmodSync(path.join(home, 'token'), 0o644);
    const w = new Windows({ pollMs: 60_000 });
    const warnings: string[] = [];
    w.on('warn', (m: string) => warnings.push(m));
    await w.start();
    w.stop();
    expect(w.list()).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/readable by other users/);
    fs.chmodSync(path.join(home, 'token'), 0o600);
    await a.close();
  });

  it.runIf(process.platform === 'win32')('a junction as the token is reported, and nothing is listed', async () => {
    registerWindow(4794, path.join(tmp, 'a'), process.pid);
    const target = path.join(tmp, 'elsewhere');
    fs.mkdirSync(target);
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync(target, path.join(home, 'token'), 'junction'); // no Developer Mode or admin needed
    const w = new Windows({ pollMs: 60_000 });
    const warnings: string[] = [];
    w.on('warn', (m: string) => warnings.push(m));
    await w.start();
    w.stop();
    expect(w.list()).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/symbolic link/);
  });
});
