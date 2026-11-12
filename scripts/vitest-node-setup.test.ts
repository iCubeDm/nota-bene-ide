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
});
