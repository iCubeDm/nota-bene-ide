import fs from 'node:fs';
import http, { type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../hub.ts';
import { whisperDir, whisperPhase } from './install.ts';
import { dictationRoutes } from './routes.ts';
import { WHISPER_MODEL, WHISPER_SIZE_MB } from './whisper.ts';
import { readPrefs } from '../prefs.ts';
import { makeWav } from './wavFixture.ts';

let home: string;
let server: http.Server | undefined;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-dictation-'));
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  await new Promise<void>((done) => { if (server) server.close(() => done()); else done(); });
  server = undefined;
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

type Done = { code: number | null; stdout: string; timedOut: boolean };
async function serve(install?: Parameters<typeof dictationRoutes>[0]['install'], transcribe?: Parameters<typeof dictationRoutes>[0]['transcribe']): Promise<string> {
  const routes = dictationRoutes({ hub: new EventHub(), install, transcribe });
  server = http.createServer(((req, res) => routes[req.url!.split('?')[0]!]!(req, res)) as RequestListener);
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const post = (base: string, p: string, body?: unknown) => fetch(base + p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

describe('dictation routes', () => {
  it('GET /dictation has the shape', async () => {
    const base = await serve();
    const r = await fetch(`${base}/dictation`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ on: false, phase: 'none', sizeMb: WHISPER_SIZE_MB, model: WHISPER_MODEL });
  });

  it('answers 405 to the wrong method', async () => {
    const base = await serve();
    expect((await post(base, '/dictation')).status).toBe(405);
    expect((await fetch(`${base}/dictation/install`)).status).toBe(405);
  });

  it('installs once: 202, then 409 while it runs, then ready', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = await serve({ npm: '/fake/npm', spawn: async (): Promise<Done> => { await gate; return { code: 0, stdout: '', timedOut: false }; }, fetchModel: async () => {} });
    expect((await post(base, '/dictation/install')).status).toBe(202);
    expect(await (await fetch(`${base}/dictation`)).json()).toMatchObject({ phase: 'installing' });
    expect((await post(base, '/dictation/install')).status).toBe(409);
    expect((await post(base, '/dictation/remove')).status).toBe(409);
    release();
    await until(() => whisperPhase() === 'ready');
    expect(await (await fetch(`${base}/dictation`)).json()).toMatchObject({ phase: 'ready' });
  });

  it('a failed install shows as failed', async () => {
    const base = await serve({ npm: '/fake/npm', spawn: async (): Promise<Done> => ({ code: 1, stdout: '', timedOut: false }), fetchModel: async () => {} });
    expect((await post(base, '/dictation/install')).status).toBe(202);
    await until(() => whisperPhase() === 'failed');
    expect(await (await fetch(`${base}/dictation`)).json()).toMatchObject({ phase: 'failed' });
  });

  it('on before ready is 409; after ready it sticks, and off is allowed anytime', async () => {
    const base = await serve({ npm: '/fake/npm', spawn: async (): Promise<Done> => ({ code: 0, stdout: '', timedOut: false }), fetchModel: async () => {} });
    expect((await post(base, '/dictation/on', { on: true })).status).toBe(409);
    expect((await post(base, '/dictation/on', { on: 'yes' })).status).toBe(400);
    await post(base, '/dictation/install');
    await until(() => whisperPhase() === 'ready');
    expect((await post(base, '/dictation/on', { on: true })).status).toBe(200);
    expect(readPrefs().whisper).toBe(true);
    expect(await (await fetch(`${base}/dictation`)).json()).toMatchObject({ on: true, phase: 'ready' });
    expect((await post(base, '/dictation/on', { on: false })).status).toBe(200);
    expect(readPrefs().whisper).toBe(false);
  });

  it('remove deletes the folder only and turns it off', async () => {
    const base = await serve({ npm: '/fake/npm', spawn: async (): Promise<Done> => ({ code: 0, stdout: '', timedOut: false }), fetchModel: async () => {} });
    await post(base, '/dictation/install');
    await until(() => whisperPhase() === 'ready');
    await post(base, '/dictation/on', { on: true });
    fs.writeFileSync(path.join(home, 'keep.txt'), 'x');
    expect((await post(base, '/dictation/remove')).status).toBe(200);
    expect(fs.existsSync(whisperDir())).toBe(false);
    expect(fs.existsSync(path.join(home, 'keep.txt'))).toBe(true);
    expect(await (await fetch(`${base}/dictation`)).json()).toMatchObject({ on: false, phase: 'none' });
  });

  describe('POST /dictation/transcribe', () => {
    const wav = { 'content-type': 'audio/wav' };
    const setup = async (calls: string[] = []) => {
      const base = await serve({ npm: '/fake/npm', spawn: async (): Promise<Done> => ({ code: 0, stdout: '', timedOut: false }), fetchModel: async () => {} }, async (_pcm, lang) => { calls.push(lang); return 'hi there'; });
      return base;
    };
    const ready = async (base: string) => {
      await post(base, '/dictation/install');
      await until(() => whisperPhase() === 'ready');
      await post(base, '/dictation/on', { on: true });
    };
    it('is 503 when not on and ready', async () => {
      const base = await setup();
      expect((await fetch(`${base}/dictation/transcribe`, { method: 'POST', headers: wav, body: new Uint8Array(makeWav()) })).status).toBe(503);
    });
    it('answers 405, 415, 400, 413 and 200 { text }', async () => {
      const langs: string[] = [];
      const base = await setup(langs);
      await ready(base);
      expect((await fetch(`${base}/dictation/transcribe`)).status).toBe(405);
      expect((await fetch(`${base}/dictation/transcribe`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status).toBe(415);
      expect((await fetch(`${base}/dictation/transcribe`, { method: 'POST', headers: wav, body: new Uint8Array(Buffer.from('garbage garbage garbage')) })).status).toBe(400);
      expect((await fetch(`${base}/dictation/transcribe`, { method: 'POST', headers: wav, body: new Uint8Array(4 * 1024 * 1024 + 1) })).status).toBe(413);
      const ok = await fetch(`${base}/dictation/transcribe?lang=ru`, { method: 'POST', headers: wav, body: new Uint8Array(makeWav()) });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ text: 'hi there' });
      expect(langs).toEqual(['ru']);
    });
    it('runs requests one at a time', async () => {
      let active = 0; let peak = 0;
      const routes = dictationRoutes({ hub: new EventHub(), install: { npm: '/fake/npm', spawn: async (): Promise<Done> => ({ code: 0, stdout: '', timedOut: false }), fetchModel: async () => {} },
        transcribe: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active--; return 'x'; } });
      server = http.createServer(((req, res) => routes[req.url!.split('?')[0]!]!(req, res)) as RequestListener);
      await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await ready(base);
      const rs = await Promise.all([1, 2, 3].map(() => fetch(`${base}/dictation/transcribe`, { method: 'POST', headers: wav, body: new Uint8Array(makeWav()) })));
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(peak).toBe(1);
    });
  });
});
