import fs from 'node:fs';
import http, { type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventHub } from '../hub.ts';
import { WhisperBusy, WhisperOff } from './hostClient.ts';
import { whisperDir, whisperPhase } from './install.ts';
import { dictationRoutes } from './routes.ts';
import { WHISPER_DISK_MB, WHISPER_DOWNLOAD_MB, WHISPER_MODEL } from './whisper.ts';
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
const npmOk = async (): Promise<Done> => { fs.mkdirSync(path.join(whisperDir(), 'node_modules'), { recursive: true }); return { code: 0, stdout: '', timedOut: false }; };
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
    expect(await r.json()).toEqual({ on: false, phase: 'none', downloadMb: WHISPER_DOWNLOAD_MB, diskMb: WHISPER_DISK_MB, dir: whisperDir(), model: WHISPER_MODEL, dictationLang: 'auto' });
  });

  it('POST /dictation/lang stores auto or a language code, and GET /dictation and the prefs show it', async () => {
    const base = await serve();
    expect((await post(base, '/dictation/lang', { lang: 'ru' })).status).toBe(200);
    expect(readPrefs().dictationLang).toBe('ru');
    expect(await (await fetch(`${base}/dictation`)).json()).toMatchObject({ dictationLang: 'ru' });
    expect((await post(base, '/dictation/lang', { lang: 'auto' })).status).toBe(200);
    expect(readPrefs().dictationLang).toBe('auto');
    expect(await (await fetch(`${base}/dictation`)).json()).toMatchObject({ dictationLang: 'auto' });
  });

  it('POST /dictation/lang refuses anything else and a wrong method', async () => {
    const base = await serve();
    await post(base, '/dictation/lang', { lang: 'de' });
    for (const bad of [{ lang: 'AUTO' }, { lang: 'english' }, { lang: 'e' }, { lang: '' }, { lang: 5 }, { lang: null }, {}]) {
      expect((await post(base, '/dictation/lang', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await fetch(`${base}/dictation/lang`, { method: 'POST', body: '{' })).status).toBe(400);
    expect((await fetch(`${base}/dictation/lang`)).status).toBe(405);
    expect(readPrefs().dictationLang).toBe('de'); // nothing refused was stored
  });

  it('answers 405 to the wrong method', async () => {
    const base = await serve();
    expect((await post(base, '/dictation')).status).toBe(405);
    expect((await fetch(`${base}/dictation/install`)).status).toBe(405);
  });

  it('installs once: 202, then 409 while it runs, then ready', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = await serve({ npm: '/fake/npm', spawn: async (): Promise<Done> => { await gate; return npmOk(); }, fetchModel: async () => {} });
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
    const base = await serve({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => {} });
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
    const base = await serve({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => {} });
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
      const base = await serve({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => {} }, async (_pcm, lang) => { calls.push(lang); return 'hi there'; });
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
      expect(await ok.json()).toEqual({ text: 'hi there', lang: 'ru' });
      expect(langs).toEqual(['ru']);
    });
    it('refuses a bad lang with 400 instead of a 500, and takes two or three lowercase letters', async () => {
      const langs: string[] = [];
      const base = await setup(langs);
      await ready(base);
      const go = (q: string) => fetch(`${base}/dictation/transcribe${q}`, { method: 'POST', headers: wav, body: new Uint8Array(makeWav()) });
      for (const bad of ['?lang=../x', '?lang=EN', '?lang=e', '?lang=engl', '?lang=e1', '?lang=%00%00']) expect((await go(bad)).status, bad).toBe(400);
      expect(langs).toEqual([]);
      expect((await go('?lang=yue')).status).toBe(200);
      expect((await go('')).status).toBe(200);
      expect(langs).toEqual(['yue', 'en']);
    });
    it('?detect=1 asks for detection and the answer names the language used', async () => {
      const asked: (boolean | undefined)[] = [];
      const base = await serve({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => {} }, async (_pcm, lang, detect) => { asked.push(detect); return { text: 'hola', lang: detect ? 'es' : lang }; });
      await ready(base);
      const go = (q: string) => fetch(`${base}/dictation/transcribe${q}`, { method: 'POST', headers: wav, body: new Uint8Array(makeWav()) }).then((r) => r.json());
      expect(await go('?lang=en&detect=1')).toEqual({ text: 'hola', lang: 'es' });
      expect(await go('?lang=en')).toEqual({ text: 'hola', lang: 'en' }); // an old client: pinned
      expect(await go('?lang=ru&detect=0')).toEqual({ text: 'hola', lang: 'ru' });
      expect(asked).toEqual([true, false, false]);
    });
    it('a full host queue is a 503 {error: busy}, Whisper removed under the job a 503 off', async () => {
      let n = 0;
      const base = await serve({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => {} }, async () => { throw ++n === 1 ? new WhisperBusy('Whisper is busy') : new WhisperOff('Whisper is off'); });
      await ready(base);
      const go = () => fetch(`${base}/dictation/transcribe`, { method: 'POST', headers: wav, body: new Uint8Array(makeWav()) });
      const busy = await go();
      expect(busy.status).toBe(503);
      expect(await busy.json()).toEqual({ error: 'busy' });
      const off = await go();
      expect(off.status).toBe(503);
      expect(await off.json()).toEqual({ error: 'dictation is off' });
    });
    it('any other failure is still a 500', async () => {
      const base = await serve({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => {} }, async () => { throw new Error('the model failed'); });
      await ready(base);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const r = await fetch(`${base}/dictation/transcribe`, { method: 'POST', headers: wav, body: new Uint8Array(makeWav()) });
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: 'the model failed' });
    });
    it('a client that hangs up before the answer aborts the job, and nothing is reported', async () => {
      let signal: AbortSignal | undefined;
      let begun!: () => void;
      const started = new Promise<void>((resolve) => { begun = resolve; });
      let calls = 0;
      const base = await serve({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => {} }, async (_pcm, _lang, _detect, s) => {
        if (++calls > 1) return 'next';
        signal = s;
        begun();
        return new Promise((_, reject) => s!.addEventListener('abort', () => reject(s!.reason), { once: true }));
      });
      await ready(base);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ac = new AbortController();
      fetch(`${base}/dictation/transcribe`, { method: 'POST', headers: wav, body: new Uint8Array(makeWav()), signal: ac.signal }).catch(() => {});
      await started;
      expect(signal!.aborted).toBe(false); // a request being served is not an abandoned one
      const aborted = new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
      ac.abort();
      await aborted;
      // the next request is served after the abandoned one left the queue, and the abandoned one was no error
      expect((await fetch(`${base}/dictation/transcribe`, { method: 'POST', headers: wav, body: new Uint8Array(makeWav()) })).status).toBe(200);
      expect(errors).not.toHaveBeenCalled();
    });
    it('a client that waits for its answer is not aborted when the answer is sent', async () => {
      let signal: AbortSignal | undefined;
      const base = await serve({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => {} }, async (_pcm, _lang, _detect, s) => { signal = s; return 'done'; });
      await ready(base);
      const r = await fetch(`${base}/dictation/transcribe`, { method: 'POST', headers: wav, body: new Uint8Array(makeWav()) });
      expect(r.status).toBe(200);
      await r.json(); // the response is complete: its `close` event has been emitted before the client could see it
      expect(signal!.aborted).toBe(false);
    });
    it('runs requests one at a time', async () => {
      let active = 0; let peak = 0;
      const routes = dictationRoutes({ hub: new EventHub(), install: { npm: '/fake/npm', spawn: npmOk, fetchModel: async () => {} },
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
