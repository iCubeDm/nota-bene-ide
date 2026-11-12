import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeControl, controlClient, running, serveControl, socketPath, write } from './control.ts';
import { remoteDir } from './store.ts';

let home: string;
const saved = process.env.NOTA_BENE_HOME;
const servers: net.Server[] = [];
beforeEach(() => {
  // short: the socket's path must fit in sun_path (104 bytes on macOS)
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nbk-'));
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  for (const s of servers.splice(0)) await closeControl(s);
  if (saved === undefined) delete process.env.NOTA_BENE_HOME;
  else process.env.NOTA_BENE_HOME = saved;
  fs.rmSync(home, { recursive: true, force: true });
});

const echo = async () => {
  const srv = await serveControl((m, sock) => write(sock, { echo: m }));
  servers.push(srv);
  return srv;
};

/** What a raw connection gets back for `send` (each line written as is) until the connector closes it or `ms` pass. */
async function raw(send: string[], ms = 1000): Promise<{ lines: string[]; closed: boolean }> {
  const s = net.connect(socketPath());
  let buf = '';
  s.setEncoding('utf8');
  s.on('data', (d: string) => (buf += d));
  s.on('error', () => {});
  await new Promise<void>((r) => s.once('connect', () => r()));
  for (const l of send) s.write(`${l}\n`);
  const closed = await new Promise<boolean>((r) => {
    const t = setTimeout(() => r(false), ms);
    s.once('close', () => { clearTimeout(t); r(true); });
  });
  s.destroy();
  return { lines: buf.split('\n').filter(Boolean), closed };
}

describe('control socket', () => {
  it('a client talks to the connector; running() sees it, and not after it stopped', async () => {
    expect(await running()).toBe(false);
    const srv = await echo();
    expect(await running()).toBe(true);
    const cl = await controlClient();
    cl.send({ op: 'status' });
    expect(await cl.next()).toEqual({ echo: { op: 'status' } });
    expect(cl.events).toEqual([{ echo: { op: 'status' } }]); // the handshake is not among the messages
    cl.close();
    await closeControl(servers.pop()!);
    expect(srv.listening).toBe(false);
    expect(await running()).toBe(false);
    await expect(controlClient()).rejects.toThrow(/not running/);
  });

  it.skipIf(process.platform === 'win32')('POSIX: a socket of mode 600 under <home>/remote, and no control secret', async () => {
    await echo();
    expect(socketPath()).toBe(path.join(remoteDir(), 'control.sock'));
    expect(fs.statSync(socketPath()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(remoteDir(), 'control-secret'))).toBe(false);
    expect((await raw(['{"op":"status"}'])).lines).toEqual(['{"echo":{"op":"status"}}']);
  });

  describe.skipIf(process.platform !== 'win32')('Windows named pipe', () => {
    it('is named after the real state base path, the same for every spelling of it', () => {
      const p = socketPath();
      expect(p).toMatch(/^\\\\\.\\pipe\\nota-bene-remote-[0-9a-f]{16}$/);
      process.env.NOTA_BENE_HOME = `${home.toUpperCase()}\\`;
      expect(socketPath()).toBe(p);
      process.env.NOTA_BENE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nbk-'));
      try {
        expect(socketPath()).not.toBe(p);
      } finally {
        fs.rmSync(process.env.NOTA_BENE_HOME, { recursive: true, force: true });
      }
    });

    it('makes the secret once, 64 hex characters in <home>/remote/control-secret', async () => {
      await echo();
      const file = path.join(remoteDir(), 'control-secret');
      const s = fs.readFileSync(file, 'utf8');
      expect(s).toMatch(/^[0-9a-f]{64}$/);
      (await controlClient()).close();
      expect(fs.readFileSync(file, 'utf8')).toBe(s);
    });

    it('a second connector cannot take the pipe', async () => {
      await echo();
      await expect(serveControl(() => {})).rejects.toThrow(/EADDRINUSE/);
    });

    it('a connection that does not prove the secret is challenged, served nothing and closed', async () => {
      await echo();
      const plain = await raw(['{"op":"status"}']);
      expect(plain.closed).toBe(true);
      expect(plain.lines).toHaveLength(1);
      expect(JSON.parse(plain.lines[0]!)).toMatchObject({ t: 'challenge', nonce: expect.stringMatching(/^[0-9a-f]{64}$/) });
      const forged = await raw([JSON.stringify({ op: 'auth', nonce: 'a'.repeat(64), proof: 'b'.repeat(64) }), '{"op":"status"}']);
      expect(forged.closed).toBe(true);
      expect(forged.lines.map((l) => JSON.parse(l).t)).toEqual(['challenge']);
    });

    it('a client holding another secret is refused, and one silent past the wait is dropped', async () => {
      await echo();
      const file = path.join(remoteDir(), 'control-secret');
      const theirs = fs.readFileSync(file, 'utf8');
      fs.rmSync(file);
      fs.writeFileSync(file, 'c'.repeat(64), { mode: 0o600 });
      await expect(controlClient()).rejects.toThrow(/closed the connection/);
      fs.rmSync(file);
      fs.writeFileSync(file, theirs, { mode: 0o600 });
      expect((await raw([], 7000)).closed).toBe(true);
    }, 15_000);

    it('a client refuses a pipe that answers without proving the secret', async () => {
      fs.writeFileSync(path.join(remoteDir(), 'control-secret'), 'd'.repeat(64), { mode: 0o600 });
      const fake = net.createServer((sock) => {
        sock.on('error', () => {});
        sock.on('data', () => write(sock, { t: 'auth', proof: 'e'.repeat(64) }));
        write(sock, { t: 'challenge', nonce: 'f'.repeat(64) });
      });
      await new Promise<void>((r) => fake.listen(socketPath(), () => r()));
      try {
        await expect(controlClient()).rejects.toThrow(/not nota-bene remote/);
      } finally {
        await new Promise((r) => fake.close(r));
      }
    });
  });
});
