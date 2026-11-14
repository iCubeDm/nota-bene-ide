// Test helper: the real relay (relay/cmd/nb-relay), built once per test process with the Go toolchain and run in plain
// HTTP mode on a loopback port. A missing `go` fails the test that needs it: it is never skipped.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HIDDEN } from '../platform.ts';

const relaySrc = fileURLToPath(new URL('../../../relay', import.meta.url));
let built: Promise<string> | undefined;

function build(): Promise<string> {
  built ??= (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-relay-bin-'));
    const bin = path.join(dir, process.platform === 'win32' ? 'nb-relay.exe' : 'nb-relay');
    await promisify(execFile)('go', ['build', '-o', bin, './cmd/nb-relay'], { cwd: relaySrc, ...HIDDEN });
    return bin;
  })();
  return built;
}

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

export type TestRelay = {
  url: string;
  port: number;
  /** everything the relay wrote to stdout and stderr */
  output: () => string;
  stop: () => Promise<void>;
  /** stops it and starts a new one on the same port */
  restart: () => Promise<void>;
};

/** Runs `nb-relay invite` on a members file and returns the code it printed. */
export async function inviteMember(file: string, name: string, hosts = 3): Promise<string> {
  const { stdout } = await promisify(execFile)(await build(), ['invite', '-members', file, '-hosts', String(hosts), name], HIDDEN);
  return stdout.trim();
}

/** `members`: the relay admits only hosts signed by a key in this file (`-members`). */
export async function startRelay(o: { members?: string } = {}): Promise<TestRelay> {
  const bin = await build();
  const port = await freePort();
  let out = '';
  let child: ChildProcess | undefined;
  const up = async () => {
    child = spawn(bin, ['-listen', `127.0.0.1:${port}`, ...(o.members ? ['-members', o.members] : [])], { stdio: ['ignore', 'pipe', 'pipe'], ...HIDDEN });
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (out += d));
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/healthz`);
        if ((await r.text()) === 'ok') return;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`the relay did not start: ${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const stop = async () => {
    const c = child;
    child = undefined;
    if (!c || c.exitCode !== null) return;
    await new Promise<void>((r) => {
      c.once('exit', () => r());
      c.kill('SIGTERM');
    });
  };
  await up();
  return { url: `ws://127.0.0.1:${port}`, port, output: () => out, stop, restart: async () => { await stop(); await up(); } };
}
