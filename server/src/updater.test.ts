import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launcherOf, patchUpdateState, writeCurrent } from './runtime.ts';
import { updater } from './updater.ts';

let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
const prevOff = process.env.NOTA_BENE_NO_UPDATE_CHECK;
beforeEach(() => {
  vi.useFakeTimers();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-updater-'));
  process.env.NOTA_BENE_HOME = home;
  delete process.env.NOTA_BENE_NO_UPDATE_CHECK;
});
afterEach(() => {
  vi.useRealTimers();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  if (prevOff === undefined) delete process.env.NOTA_BENE_NO_UPDATE_CHECK; else process.env.NOTA_BENE_NO_UPDATE_CHECK = prevOff;
  fs.rmSync(home, { recursive: true, force: true });
});

// an installed release: a launcher file is enough for readCurrent
const release = (v: string) => {
  fs.mkdirSync(path.dirname(launcherOf(v)), { recursive: true });
  fs.writeFileSync(launcherOf(v), '');
};
const current = (v: string) => { release(v); writeCurrent(v); };

function make(o: Partial<Parameters<typeof updater>[0]> = {}) {
  const exit = vi.fn();
  const install = vi.fn(async () => 'installed' as const);
  const newer = vi.fn(async () => '1.8.0' as string | null);
  const u = updater({ version: '1.7.0', canUpdate: true, busy: () => false, tabs: () => 1, exit, newer, install, everyMs: 60_000, ...o });
  return { u, exit, install, newer };
}

describe('updater', () => {
  it('auto off: a newer release is available, nothing installs', async () => {
    const { u, install } = make();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(install).not.toHaveBeenCalled();
    expect(await u.status()).toMatchObject({ current: '1.7.0', latest: '1.8.0', phase: 'available', canUpdate: true, auto: false });
    u.stop();
  });

  it('auto on: the tick installs once', async () => {
    let done!: () => void;
    const install = vi.fn(() => new Promise<'installed'>((r) => { done = () => r('installed'); }));
    const { u } = make({ install });
    u.setAuto(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await u.status()).phase).toBe('installing');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith('1.8.0');
    done();
    u.stop();
  });

  it('a rolled-back release is not installed automatically, but install() still installs it', async () => {
    patchUpdateState((s) => ({ ...s, auto: true, rolledBack: { version: '1.8.0', at: 1 } }));
    const { u, install } = make();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(install).not.toHaveBeenCalled();
    expect((await u.status())).toMatchObject({ phase: 'rolled-back', rolledBack: '1.8.0' });
    await u.install();
    expect(install).toHaveBeenCalledWith('1.8.0');
    u.stop();
  });

  it('a failed install shows its reason and is not retried by the tick', async () => {
    patchUpdateState((s) => ({ ...s, auto: true, failed: { version: '1.8.0', at: 1, reason: 'boom' } }));
    const { u, install } = make();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(install).not.toHaveBeenCalled();
    expect(await u.status()).toMatchObject({ phase: 'failed', failed: 'boom' });
    u.stop();
  });

  it('a window on a rolled-back release is ready to go back', async () => {
    current('1.6.0');
    const { u } = make({ newer: async () => null, fromRuntime: true });
    expect((await u.status()).phase).toBe('none');
    patchUpdateState((s) => ({ ...s, rolledBack: { version: '1.7.0', at: 1 } }));
    expect((await u.status()).phase).toBe('ready');
    u.stop();
  });

  it('goes back to the launcher\'s own version too, which has no runtime folder (the first update)', async () => {
    writeCurrent('1.6.0'); // the rollback names the launcher's own version: no runtime/1.6.0
    patchUpdateState((s) => ({ ...s, rolledBack: { version: '1.7.0', at: 1 } }));
    const { u, exit } = make({ newer: async () => null, fromRuntime: true, tabs: () => 0 });
    expect((await u.status()).phase).toBe('ready');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(exit).toHaveBeenCalledWith(77);
    u.stop();
  });

  it('a newer current with no runtime folder is not ready', async () => {
    writeCurrent('1.8.0');
    const { u, exit } = make({ tabs: () => 0 });
    expect((await u.status()).phase).not.toBe('ready');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(exit).not.toHaveBeenCalled();
    u.stop();
  });

  it('a window on its own carried version never goes back', async () => {
    current('1.6.0');
    patchUpdateState((s) => ({ ...s, rolledBack: { version: '1.7.0', at: 1 } }));
    const { u, exit } = make({ newer: async () => null, tabs: () => 0 });
    expect((await u.status()).phase).not.toBe('ready');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(exit).not.toHaveBeenCalled();
    u.stop();
  });

  it('never hands over toward the rolled-back release', async () => {
    current('1.8.0');
    patchUpdateState((s) => ({ ...s, rolledBack: { version: '1.8.0', at: 1 } }));
    const { u, exit } = make({ tabs: () => 0 });
    expect((await u.status()).phase).not.toBe('ready');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(exit).not.toHaveBeenCalled();
    expect(u.restart()).toBe('not-ready');
    u.stop();
  });

  it('ready with no tab and an idle agent hands over', async () => {
    current('1.8.0');
    let tabs = 1;
    let busy = true;
    const { u, exit } = make({ tabs: () => tabs, busy: () => busy });
    expect((await u.status()).phase).toBe('ready');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exit).not.toHaveBeenCalled(); // a tab is connected
    tabs = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exit).not.toHaveBeenCalled(); // a turn is running
    busy = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(exit).toHaveBeenCalledWith(77);
    u.stop();
  });

  it('restart answers busy while a turn runs', async () => {
    current('1.8.0');
    let busy = true;
    const { u, exit } = make({ busy: () => busy });
    expect(u.restart()).toBe('busy');
    busy = false;
    expect(u.restart()).toBe('ok');
    expect(exit).not.toHaveBeenCalled(); // after the reply
    await vi.advanceTimersByTimeAsync(500);
    expect(exit).toHaveBeenCalledWith(77);
    u.stop();
  });

  it('restart is not-ready without a newer current', () => {
    const { u } = make();
    expect(u.restart()).toBe('not-ready');
    u.stop();
  });

  it('cannot update: no ticks, install refused', async () => {
    current('1.8.0');
    patchUpdateState((s) => ({ ...s, auto: true }));
    const { u, install, newer, exit } = make({ canUpdate: false, tabs: () => 0 });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(newer).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    await u.install();
    expect(install).not.toHaveBeenCalled();
    expect(await u.status()).toMatchObject({ canUpdate: false, phase: 'available', latest: '1.8.0' });
    expect(u.restart()).toBe('not-ready');
    u.stop();
  });

  it('with the update check off nothing installs or hands over, and canUpdate says so', async () => {
    current('1.8.0');
    patchUpdateState((s) => ({ ...s, auto: true }));
    const { u, install, exit } = make({ tabs: () => 0 });
    process.env.NOTA_BENE_NO_UPDATE_CHECK = '1';
    await vi.advanceTimersByTimeAsync(300_000);
    expect(install).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect((await u.status()).canUpdate).toBe(false);
    await u.install();
    expect(install).not.toHaveBeenCalled();
    u.stop();
  });

  it('a source checkout (version not x.y.z) cannot update', async () => {
    const { u } = make({ version: 'v1.7.0-3-gabc123' });
    expect((await u.status()).canUpdate).toBe(false);
    u.stop();
  });

  it('updatedFrom is reported only for an older release', async () => {
    expect((await make({ updatedFrom: '1.6.0' }).u.status()).updatedFrom).toBe('1.6.0');
    expect((await make({ updatedFrom: '1.8.0' }).u.status()).updatedFrom).toBeUndefined();
    expect((await make({ updatedFrom: 'junk' }).u.status()).updatedFrom).toBeUndefined();
  });

  it('the log is the update log in the runtime folder', async () => {
    const { u } = make();
    expect((await u.status()).log).toBe(path.join(home, 'runtime', 'update.log'));
    u.stop();
  });
});
