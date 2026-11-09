import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publicOf } from './noise.ts';
import {
  addDevice, b64u, deviceHash, fingerprint, fromB64u, hostId, hostKey, pairProof, pairTicket, pairUri, parsePairUri,
  readConfig, readDevices, remoteDir, removeDevice, writeConfig,
} from './store.ts';

let home: string;
const saved = process.env.NOTA_BENE_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-remote-'));
  process.env.NOTA_BENE_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.NOTA_BENE_HOME;
  else process.env.NOTA_BENE_HOME = saved;
  fs.rmSync(home, { recursive: true, force: true });
});

const seq = (from: number) => Buffer.from(Array.from({ length: 32 }, (_, i) => from + i));
// relay/PROTOCOL.md's worked example: device private key = bytes 0x01..0x20
const examplePhone = publicOf(seq(0x01));

/** The worked-example table of CHANNEL.md's Pairing section, as item → value. */
function channelExample(): Record<string, string> {
  const md = fs.readFileSync(new URL('./CHANNEL.md', import.meta.url), 'utf8');
  const section = md.slice(md.indexOf('## Pairing'));
  const rows: Record<string, string> = {};
  for (const m of section.matchAll(/^\| ([^|]+?) \| `([^`]+)` \|$/gm)) rows[m[1]!] = m[2]!;
  return rows;
}

describe('remote store', () => {
  it('creates the host key once, mode 600, in a 700 folder', () => {
    const a = hostKey();
    const b = hostKey();
    expect(a.priv.equals(b.priv)).toBe(true);
    expect(a.pub.equals(publicOf(a.priv))).toBe(true);
    const file = path.join(remoteDir(), 'host.key');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(remoteDir()).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(file, 'utf8').trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses a host key readable by others', () => {
    hostKey();
    const file = path.join(remoteDir(), 'host.key');
    fs.chmodSync(file, 0o640);
    expect(() => hostKey()).toThrow(/chmod 600/);
  });

  it('derives the ids of the relay protocol example', () => {
    expect(deviceHash(examplePhone)).toBe('qqj_9wO1CyKX9PbhNQj3JCDZb9Aeu4TLB0RJyq72QEE');
    expect(hostId(publicOf(seq(0x21)))).toBe('WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns');
  });

  it('base64url: exact length and alphabet', () => {
    expect(fromB64u(b64u(seq(1)), 32).equals(seq(1))).toBe(true);
    expect(() => fromB64u(b64u(seq(1)), 16)).toThrow();
    expect(() => fromB64u(b64u(seq(1)).slice(0, 42) + '+', 32)).toThrow();
    expect(() => fromB64u(b64u(seq(1)) + '=', 32)).toThrow();
  });

  it('fingerprint: 16 base32 characters in groups of 4', () => {
    expect(fingerprint(examplePhone)).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
  });

  it('adds a device once, removes it by id or prefix', () => {
    const one = addDevice(examplePhone, 'Pixel');
    expect(addDevice(examplePhone, 'Pixel').id).toBe(one.id);
    expect(readDevices()).toHaveLength(1);
    expect(one.id).toBe(fingerprint(examplePhone).replace(/-/g, '').slice(0, 4));
    expect(one.pub).toBe(b64u(examplePhone));
    expect(fs.statSync(path.join(remoteDir(), 'devices.json')).mode & 0o777).toBe(0o600);
    const two = addDevice(publicOf(seq(0x50)));
    expect(removeDevice('zzzzzzzz')).toBeNull();
    expect(removeDevice(two.id)?.id).toBe(two.id);
    expect(removeDevice(one.id.slice(0, 2))?.id).toBe(one.id);
    expect(readDevices()).toEqual([]);
  });

  it('refuses an ambiguous prefix', () => {
    // find two keys whose ids share their first character
    const seen = new Map<string, Buffer>();
    let i = 0x60;
    let pair: [Buffer, Buffer] | undefined;
    while (!pair) {
      const pub = publicOf(seq(i++ % 200));
      const c = fingerprint(pub)[0]!;
      const other = seen.get(c);
      if (other && !other.equals(pub)) pair = [other, pub];
      else seen.set(c, pub);
    }
    const a = addDevice(pair[0]);
    addDevice(pair[1]);
    expect(() => removeDevice(a.id[0]!)).toThrow(/ambiguous/);
  });

  it('validates the relay URL', () => {
    expect(() => writeConfig({ relay: 'http://relay.example.com' })).toThrow();
    expect(() => writeConfig({ relay: 'ws://relay.example.com' })).toThrow();
    writeConfig({ relay: 'ws://127.0.0.1:9000' });
    writeConfig({ relay: 'wss://relay.example.com' });
    expect(readConfig()).toEqual({ relay: 'wss://relay.example.com' });
  });

  it('pair URI round trip', () => {
    const o = { relay: 'wss://relay.example.com', hostPub: seq(0x10), secret: seq(0x41) };
    const uri = pairUri(o);
    expect(uri.startsWith('nbremote://pair?v=1&')).toBe(true);
    expect(parsePairUri(uri)).toEqual(o);
    expect(() => parsePairUri(uri.replace('v=1', 'v=2'))).toThrow();
  });

  it('ticket and proof match the worked example in CHANNEL.md', () => {
    const t = channelExample();
    const secret = seq(0x41);
    expect(t['pairing secret (bytes 0x41..0x60)']).toBe(b64u(secret));
    expect(t['device public key']).toBe(b64u(examplePhone));
    expect(t['relay ticket']).toBe(b64u(pairTicket(secret)));
    expect(t['pairing proof']).toBe(b64u(pairProof(secret, examplePhone)));
    expect(t['device fingerprint']).toBe(fingerprint(examplePhone));
    expect(pairTicket(secret).equals(pairProof(secret, examplePhone))).toBe(false);
  });
});
