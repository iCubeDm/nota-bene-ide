import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./crossHost.ts', import.meta.url));

describe('crossHost', () => {
  it('prints ready and a code', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-crosshome-'));
    const child = spawn(process.execPath, [script], { env: { ...process.env, NOTA_BENE_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    const lines = readline.createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const next = async () => JSON.parse(String((await lines.next()).value)) as Record<string, unknown>;
    try {
      const ready = await next();
      expect(ready).toMatchObject({ t: 'ready', relay: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/), port: expect.any(Number) });
      child.stdin!.write('{"op":"pair"}\n');
      const code = await next();
      expect(String(code.uri)).toMatch(/^nbremote:\/\/pair\?v=1&/);
      child.stdin!.write('{"op":"stop"}\n');
      expect(await new Promise((r) => child.once('exit', r))).toBe(0);
    } finally {
      child.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
