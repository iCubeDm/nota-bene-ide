import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('the node test setup (vitest.node-setup.ts)', () => {
  it('gives every test file a state home of its own, so that none can reach the real ~/.nota-bene by forgetting to set one (named, not made: a skipped file leaves nothing)', () => {
    const home = process.env.NOTA_BENE_HOME;
    expect(home).toBeTruthy();
    expect(home!.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(home!)).toMatch(/^nb-test-home-/);
    expect(home).not.toBe(path.join(os.homedir(), '.nota-bene'));
  });

  it.skipIf(process.platform === 'win32')('refuses process.kill for -1, 0, 1 and the runner\'s own group, so a stray pid fails a test instead of killing the session', () => {
    const pgid = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim());
    for (const pid of [-1, 0, 1, pgid, -pgid]) expect(() => process.kill(pid, 0), String(pid)).toThrow(/refused/);
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })); // any other pid: the real call
  });
});
