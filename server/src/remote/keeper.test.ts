import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Connector } from './connector.ts';
import { Windows } from './discover.ts';
import { BACKOFF_MS, LegacyConnector, olderVersion, RemoteKeeper, type PairOutcome } from './keeper.ts';
import { generateKeyPair } from './noise.ts';
import { b64u, pairProof, pairTicket, parsePairUri, readConfig, remoteDir, writeConfig, writeLastError } from './store.ts';
import { relayPhone } from './testPhone.ts';
import { startRelay, type TestRelay } from './testRelay.ts';

let relay: TestRelay;
let tmp: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void> | void)[] = [];
/** the connectors started in this test, last one last */
const started: Connector[] = [];
/** stopped first: a keeper's pass must not start a connector while the test's connectors go */
const keepers: RemoteKeeper[] = [];

beforeAll(async () => {
  relay = await startRelay();
}, 120_000);
afterAll(async () => {
  await relay?.stop();
});
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nbk-')));
  process.env.NOTA_BENE_HOME = path.join(tmp, 'h');
});
afterEach(async () => {
  for (const k of keepers.splice(0)) k.stop();
  while (closers.length) await closers.pop()!();
  started.length = 0;
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const until = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A connector in this process, as `nota-bene remote` would run: it stops when asked to exit. */
async function connector(o: { managed?: boolean; version?: string } = {}): Promise<Connector> {
  const c = new Connector({ relay: readConfig().relay ?? relay.url, backoff: { minMs: 50, maxMs: 200 }, windows: new Windows(), idleExitMs: 3_600_000, ...o });
  c.on('exit', () => void c.stop());
  await c.start();
  started.push(c);
  closers.push(() => c.stop());
  return c;
}

function keeper(o: { version?: string; spawn?: () => void; now?: () => number } = {}) {
  const spawns: number[] = [];
  const k = new RemoteKeeper({
    version: '9.9.9', spawnWaitMs: 1500, pollMs: 3_600_000,
    spawn: () => {
      spawns.push(Date.now());
      if (o.spawn) o.spawn();
      // a real process takes a moment to bind its socket: a window that does not wait on the lock would start a second one
      else setTimeout(() => void connector({ managed: true, version: '9.9.9' }), 200);
    },
    ...(o.now ? { now: o.now } : {}),
    ...(o.version ? { version: o.version } : {}),
  });
  keepers.push(k);
  return { k, spawns };
}

describe('remote keeper', () => {
  it('a stopped keeper starts nothing (the window is closing)', async () => {
    writeConfig({ relay: relay.url });
    const { k, spawns } = keeper();
    k.stop();
    expect(await k.refresh()).toMatchObject({ running: false });
    expect(spawns).toEqual([]);
  });

  it('no relay saved: nothing is started, access reads as not set up', async () => {
    const { k, spawns } = keeper();
    const s = await k.refresh();
    expect(spawns).toEqual([]);
    expect(s).toMatchObject({ configured: false, running: false });
    expect(fs.existsSync(path.join(process.env.NOTA_BENE_HOME!, 'remote'))).toBe(false); // asking created nothing
  });

  it('a saved relay starts one connector, which goes online', async () => {
    writeConfig({ relay: relay.url });
    const { k, spawns } = keeper();
    expect(await k.refresh()).toMatchObject({ configured: true, enabled: true, running: true, relay: relay.url, legacy: false });
    expect(spawns).toHaveLength(1);
    await until(async () => (await k.refresh()).online);
    expect(k.state().hostFingerprint).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
  });

  it('two windows finding nobody at the same moment start one connector between them', async () => {
    writeConfig({ relay: relay.url });
    const a = keeper();
    const b = keeper();
    const [sa, sb] = await Promise.all([a.k.refresh(), b.k.refresh()]);
    expect(a.spawns.length + b.spawns.length).toBe(1);
    expect(sa.running && sb.running).toBe(true);
  });

  it('a connector started by hand is reused', async () => {
    writeConfig({ relay: relay.url });
    await connector({ version: '9.9.9' });
    const { k, spawns } = keeper();
    expect(await k.refresh()).toMatchObject({ running: true, legacy: false });
    expect(spawns).toEqual([]);
  });

  it('off stops a connector started by hand, and no window starts another', async () => {
    writeConfig({ relay: relay.url });
    const hand = await connector({ version: '9.9.9' });
    const exits: string[] = [];
    hand.on('exit', (w: string) => exits.push(w));
    const { k, spawns } = keeper();
    await k.refresh();
    const r = await k.setConfig({ enabled: false });
    expect(exits).toEqual(['stop']);
    expect(r.stopped).toBe('hand');
    expect(r.state).toMatchObject({ enabled: false, running: false });
    expect(await k.refresh()).toMatchObject({ running: false });
    expect(spawns).toEqual([]);
    const on = await k.setConfig({ enabled: true });
    expect(on.state.running).toBe(true);
    expect(spawns).toHaveLength(1);
  });

  it('a connector of an older version that predates the switches is reused and reported, never stopped', async () => {
    writeConfig({ relay: relay.url });
    await connector(); // no version: what `status` of an older release answers
    const { k, spawns } = keeper();
    expect(await k.refresh()).toMatchObject({ running: true, legacy: true });
    await expect(k.setConfig({ enabled: false })).rejects.toBeInstanceOf(LegacyConnector);
    expect(readConfig().enabled).toBeUndefined();
    expect(spawns).toEqual([]);
  });

  it('versions: only an older release is older', () => {
    expect(olderVersion('1.10.0', '1.11.0')).toBe(true);
    expect(olderVersion('1.9.9', '1.10.0')).toBe(true);
    expect(olderVersion('1.11.0-rc.1', '1.11.0')).toBe(true);
    expect(olderVersion('1.11.0', '1.11.0')).toBe(false);
    expect(olderVersion('1.12.0', '1.11.0')).toBe(false);
    expect(olderVersion(undefined, '1.11.0')).toBe(false);
    expect(olderVersion('dev', '1.11.0')).toBe(false);
  });

  it('a newer managed connector is kept by a window of the previous release', async () => {
    writeConfig({ relay: relay.url });
    const newer = await connector({ managed: true, version: '10.0.0' });
    const exits: string[] = [];
    newer.on('exit', (w: string) => exits.push(w));
    const { k, spawns } = keeper();
    expect(await k.refresh()).toMatchObject({ running: true });
    expect(exits).toEqual([]);
    expect(spawns).toEqual([]);
  });

  it('a managed connector of an older version is replaced', async () => {
    writeConfig({ relay: relay.url });
    const old = await connector({ managed: true, version: '0.0.1' });
    const exits: string[] = [];
    old.on('exit', (w: string) => exits.push(w));
    const { k, spawns } = keeper();
    expect(await k.refresh()).toMatchObject({ running: true });
    expect(exits).toEqual(['stop']);
    expect(spawns).toHaveLength(1);
  });

  it('a relay refusal is shown, and the next start waits; a change in the tab starts at once', async () => {
    writeConfig({ relay: relay.url });
    let now = 1_000_000;
    // the connector of a host the relay refuses: it writes why and exits before its socket ever answers
    const { k, spawns } = keeper({ now: () => now, spawn: () => writeLastError({ code: 4402, message: 'the relay does not admit this host', at: now }) });
    const s = await k.refresh();
    expect(s).toMatchObject({ running: false, lastError: { code: 4402 }, startFailed: false });
    expect(spawns).toHaveLength(1);
    now += BACKOFF_MS[0]! - 1000;
    await k.refresh();
    expect(spawns).toHaveLength(1);
    now += 2000;
    await k.refresh();
    expect(spawns).toHaveLength(2);
    await k.refresh(); // the second failure waits longer
    now += BACKOFF_MS[0]! + 1000;
    await k.refresh();
    expect(spawns).toHaveLength(2);
    const r = await k.setConfig({ relay: relay.url });
    expect(spawns).toHaveLength(3);
    expect(r.state.lastError).toMatchObject({ code: 4402 }); // written again by this start
  });

  it('a connector that went online and was then refused for good is not started again at once', async () => {
    writeConfig({ relay: relay.url });
    let now = 1_000_000;
    const { k, spawns } = keeper({ now: () => now });
    expect(await k.refresh()).toMatchObject({ running: true });
    // what a refused connector does: it writes why and exits
    writeLastError({ code: 4402, message: 'the relay does not admit this host', at: now });
    await started.pop()!.stop();
    expect(await k.refresh()).toMatchObject({ running: false, lastError: { code: 4402 } });
    expect(spawns).toHaveLength(1);
    now += BACKOFF_MS[0]! + 1000;
    expect(await k.refresh()).toMatchObject({ running: true });
    expect(spawns).toHaveLength(2);
  });

  it('a connector that does not come up is reported, with its log', async () => {
    writeConfig({ relay: relay.url });
    const { k } = keeper({ spawn: () => {} });
    expect(await k.refresh()).toMatchObject({ running: false, startFailed: true, lastError: null });
    expect(fs.existsSync(path.join(remoteDir(), 'spawn.lock'))).toBe(false);
  });

  it('pairs a phone: the code as a QR, the outcome as an event, the phone in the list', async () => {
    writeConfig({ relay: relay.url });
    const { k } = keeper();
    await k.refresh();
    await until(async () => (await k.refresh()).online);
    const outcomes: PairOutcome[] = [];
    k.on('pair', (o: PairOutcome) => outcomes.push(o));
    const code = await k.pair();
    expect(code.qr).toMatch(/^<svg/);
    expect(code.uri).toMatch(/^nbremote:\/\/pair\?/);
    expect((await k.refresh()).pairing).toMatchObject({ mine: true });
    const { relay: url, hostPub, secret } = parsePairUri(code.uri);
    const key = generateKeyPair();
    const p = relayPhone({ url, hostPub, key, ticket: pairTicket(secret), hello: { v: 1, name: 'Test phone', pair: b64u(pairProof(secret, key.pub)) } });
    closers.push(() => p.ws.terminate());
    await p.phone.ready;
    await until(() => outcomes.length === 1);
    expect(outcomes[0]).toMatchObject({ result: 'paired', device: { name: 'Test phone' } });
    expect(outcomes[0]!.device!.fingerprint).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
    await until(async () => (await k.refresh()).devices.length === 1);
    expect(k.state().pairing).toBeNull();
    const id = k.state().devices[0]!.id;
    expect(await k.revoke(id)).toEqual({ ok: true });
    expect(await k.revoke(id)).toMatchObject({ ok: false });
  });

  it('cancel withdraws the code', async () => {
    writeConfig({ relay: relay.url });
    const { k } = keeper();
    await k.refresh();
    await k.pair();
    expect((await k.refresh()).pairing).not.toBeNull();
    k.cancelPair();
    await until(async () => (await k.refresh()).pairing === null);
  });
});
