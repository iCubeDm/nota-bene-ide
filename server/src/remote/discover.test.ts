import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBackend } from '../agent/fake.ts';
import { providerStateDir } from '../agent/provider.ts';
import { writePrivateFile } from '../auth.ts';
import { startServer } from '../server.ts';
import { readWindows, registerWindow } from '../windows.ts';
import { windowInfo, Windows } from './discover.ts';

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

/** An in-process window of `provider`, registered in that provider's registry. */
async function window(provider: 'claude' | 'codex', dir: string) {
  process.env.NOTA_BENE_AGENT = provider;
  try {
    const s = await startServer({ cwd: path.join(tmp, dir), port: 0, backend: fakeBackend([]), webDist: path.join(tmp, 'dist'), exit: () => {} });
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
  it('lists the windows of every provider, each proved with its own token', async () => {
    const a = await window('claude', 'a');
    const b = await window('codex', 'b');
    const w = new Windows({ pollMs: 60_000 });
    await w.start();
    try {
      const list = w.list().map(({ port, provider, root }) => ({ port, provider, root }));
      expect(list).toEqual([
        { port: a.port, provider: 'claude', root: path.join(tmp, 'a') },
        { port: b.port, provider: 'codex', root: path.join(tmp, 'b') },
      ].sort((x, y) => x.port - y.port));
      const info = await windowInfo(w.get(b.port)!);
      expect(info?.root).toBe(path.join(tmp, 'b'));
      expect(w.get(a.port)!.bearer).toMatch(/^Bearer [0-9a-f]{64}$/);
    } finally {
      w.stop();
    }
  });

  it('does not list an entry whose port answers another provider\'s proof', async () => {
    const a = await window('claude', 'a');
    const omp = providerStateDir(home, 'omp');
    fs.mkdirSync(path.join(omp, 'windows'), { recursive: true, mode: 0o700 });
    writePrivateFile(path.join(omp, 'token'), 'ab'.repeat(32));
    fs.writeFileSync(path.join(omp, 'windows', `${a.port}.json`), JSON.stringify({ root: path.join(tmp, 'a'), pid: process.pid, startedAt: 1 }));
    expect(Object.keys(readWindows(omp))).toEqual([String(a.port)]);
    const w = new Windows({ pollMs: 60_000 });
    await w.start();
    try {
      expect(w.list().map((x) => [x.port, x.provider])).toEqual([[a.port, 'claude']]);
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

  it('a provider without a token is skipped quietly; a loose token is reported', async () => {
    await window('claude', 'a');
    const codex = providerStateDir(home, 'codex');
    fs.mkdirSync(codex, { recursive: true });
    fs.writeFileSync(path.join(codex, 'token'), 'cd'.repeat(32), { mode: 0o644 });
    const w = new Windows({ pollMs: 60_000 });
    const warnings: string[] = [];
    w.on('warn', (m: string) => warnings.push(m));
    await w.start();
    w.stop();
    expect(w.list()).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/readable by other users/);
  });
});
