// Every node-project test file starts with a state home of its own, so that a test that forgets to set NOTA_BENE_HOME cannot
// reach the real ~/.nota-bene: with it a Whisper host started by mistake once ran on the real home with the real model. A test
// that wants a home of its own sets one and restores what it found, which is this one. The folder is not made here, only named
// (what needs it makes it), and removed after the file: vitest runs no afterAll for a file whose tests are all skipped, and a
// folder made up front would be left behind by those.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll } from 'vitest';

const home = path.join(os.tmpdir(), `nb-test-home-${randomBytes(4).toString('hex')}`);
process.env.NOTA_BENE_HOME = home;
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });

// No test may signal pid 1, 0, -1 or this runner's own process group: once a pid read from `ps` was the parent an orphan
// gets (1), and killTree(1) became process.kill(-1, 'SIGKILL'), which killed every process of the user. Such a call throws
// here and fails its test. It guards this worker only: what the tests spawn is guarded by killTree itself.
const pgid = process.platform === 'win32'
  ? undefined
  : Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim()) || undefined;
const realKill = process.kill.bind(process);
process.kill = ((pid: number, signal?: string | number) => {
  const n = Number(pid);
  if (n === -1 || n === 0 || n === 1 || (pgid !== undefined && Math.abs(n) === pgid)) {
    throw new Error(`test guard: process.kill(${pid}) refused, it would signal the session's own processes`);
  }
  return realKill(pid, signal);
}) as typeof process.kill;
