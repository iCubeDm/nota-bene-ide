// Issue 297: this computer as a device of another, end to end. B is crossHost.ts in its own process and home (a real
// relay, a window, its connector); A is this process with another home and no relay of its own. A pairs with B's code,
// B lists A, A's connector keeps the link and B's windows list, B revokes A, A forgets B.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connector } from './connector.ts';
import { controlClient, type Msg } from './control.ts';
import { computerName } from './device.ts';
import { pairHost } from './hostLink.ts';
import { fingerprint, parsePairUri, readHosts, Refusal, removeHost } from './store.ts';

const script = fileURLToPath(new URL('./crossHost.ts', import.meta.url));
const prevHome = process.env.NOTA_BENE_HOME;
let tmp: string;
let b: ChildProcess;
let next: () => Promise<Msg>;
let ready: Msg;

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nbl-')));
  b = spawn(process.execPath, [script], { env: { ...process.env, NOTA_BENE_HOME: path.join(tmp, 'b') }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const lines = readline.createInterface({ input: b.stdout! })[Symbol.asyncIterator]();
  next = async () => JSON.parse(String((await lines.next()).value)) as Msg;
  ready = await next();
  process.env.NOTA_BENE_HOME = path.join(tmp, 'a');
}, 120_000);
afterAll(async () => {
  if (b && b.exitCode === null) {
    b.stdin!.write('{"op":"stop"}\n');
    await new Promise((r) => b.once('exit', r));
  }
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ask = (m: object) => b.stdin!.write(`${JSON.stringify(m)}\n`);
const until = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
async function status(): Promise<Msg> {
  const cl = await controlClient();
  try {
    cl.send({ op: 'status' });
    return await cl.next();
  } finally {
    cl.close();
  }
}

describe('a computer as a device of another', () => {
  it('pairs with a code, keeps the link and the windows, shows the revoke, forgets', async () => {
    ask({ op: 'pair' });
    const { uri } = await next() as { uri: string };
    const host = await pairHost(uri);
    expect(await next()).toMatchObject({ t: 'paired' });
    expect(host).toMatchObject({ relay: ready.relay, name: computerName() });
    expect(fingerprint(parsePairUri(uri).hostPub)).toBe(fingerprint(Buffer.from(host.pub, 'base64url')));
    expect(readHosts()).toEqual([host]);
    // this device is listed now: presenting the code again changes nothing
    expect((await pairHost(uri)).id).toBe(host.id);
    expect(readHosts()).toHaveLength(1);
    await expect(pairHost('nbremote://nope')).rejects.toThrow(Refusal);

    ask({ op: 'devices' });
    const devices = await next();
    expect(devices).toEqual({ t: 'devices', devices: [expect.objectContaining({ name: computerName() })] });
    const id = (devices.devices as { id: string }[])[0]!.id;

    // A as a pure client: no relay and no access key of its own
    const a = new Connector({ backoff: { minMs: 50, maxMs: 200 } });
    await a.start();
    try {
      await until(async () => ((await status()).hosts as Msg[])[0]?.state === 'online');
      const st = await status();
      expect(st).toMatchObject({ relay: null, hostFingerprint: null, online: false });
      expect(st.hosts).toEqual([{ id: host.id, name: host.name, fingerprint: fingerprint(Buffer.from(host.pub, 'base64url')), state: 'online', pairedAt: host.addedAt }]);
      await until(() => a.hostWindows(host.id).some((w) => w.port === ready.port));

      ask({ op: 'revoke', id });
      expect(await next()).toEqual({ t: 'revoked' });
      await until(async () => ((await status()).hosts as Msg[])[0]?.state === 'revoked');
      expect(a.hostWindows(host.id)).toEqual([]);

      removeHost(host.id);
      const cl = await controlClient();
      cl.send({ op: 'hosts' });
      expect(await cl.next()).toEqual({ hosts: [] });
      cl.close();
      expect((await status()).hosts).toEqual([]);
    } finally {
      await a.stop();
    }
  }, 60_000);
});
