import fs from 'node:fs';
import http, { type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentStore } from '../attachments.ts';
import { makeWav } from '../dictation/wavFixture.ts';
import { EventHub } from '../hub.ts';
import { WhisperBusy, WhisperOff } from '../dictation/hostClient.ts';
import { queued } from '../dictation/transcribe.ts';
import { transcribeVoice, VoiceBusy, VoiceFailure } from './transcribe.ts';
import { voiceRoutes } from './routes.ts';
import { httpHandler } from '../http.ts';

let dir: string;
let server: http.Server | undefined;
let store: AttachmentStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-voice-'));
  store = new AttachmentStore({ dir: path.join(dir, 'attachments') });
});
afterEach(async () => {
  await new Promise<void>((done) => { if (server) server.close(() => done()); else done(); });
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

type Run = (pcm: Float32Array, lang: string, detect?: boolean) => Promise<string | { text: string; lang: string }>;
async function serve(o: { on?: boolean; run?: Run } = {}): Promise<string> {
  const routes = voiceRoutes({ hub: new EventHub(), store, on: () => o.on ?? true, transcribe: o.run ?? (async () => 'hello') });
  server = http.createServer(((req, res) => {
    const p = req.url!.split('?')[0]!;
    (routes[p] ?? routes['/voice/']!)(req, res);
  }) as RequestListener);
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const wavHeaders = { 'content-type': 'audio/wav' };
const upload = (base: string, body: Buffer, headers: Record<string, string> = wavHeaders) =>
  fetch(`${base}/voice`, { method: 'POST', headers, body: new Uint8Array(body) });

describe('POST /voice', () => {
  it('stores the recording and answers its id, length and wave', async () => {
    const base = await serve();
    const r = await upload(base, makeWav({ seconds: 2 }));
    expect(r.status).toBe(200);
    const v = (await r.json()) as { id: string; ms: number; wave: number[] };
    expect(v.id).toMatch(/^[0-9a-f]{64}$/);
    expect(v.ms).toBe(2000);
    expect(v.wave).toHaveLength(48);
    expect(Math.max(...v.wave)).toBe(31);
    expect(store.get(v.id)?.mediaType).toBe('audio/wav');
  });
  it('refuses what is not a 16 kHz mono WAV, an empty one, and other types', async () => {
    const base = await serve();
    expect((await upload(base, makeWav({ rate: 44100 }))).status).toBe(400);
    expect((await upload(base, makeWav({ seconds: 0 }))).status).toBe(400);
    expect((await upload(base, Buffer.from('x'), { 'content-type': 'audio/ogg' })).status).toBe(415);
    expect((await fetch(`${base}/voice`)).status).toBe(405);
  });
  it('refuses a body over 20 MiB and a recording over 602 s', async () => {
    const base = await serve();
    expect((await upload(base, Buffer.alloc(20 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await upload(base, makeWav({ seconds: 603 }))).status).toBe(413);
  });
});

describe('GET /voice/<id>', () => {
  it('serves the WAV whole and by ranges', async () => {
    const base = await serve();
    const wav = makeWav({ seconds: 1 });
    const id = store.put(wav, 'audio/wav');
    const all = await fetch(`${base}/voice/${id}`);
    expect(all.status).toBe(200);
    expect(all.headers.get('content-type')).toBe('audio/wav');
    expect(all.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await all.arrayBuffer())).toEqual(wav);
    const part = await fetch(`${base}/voice/${id}`, { headers: { range: 'bytes=4-11' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 4-11/${wav.length}`);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(wav.subarray(4, 12));
    expect((await fetch(`${base}/voice/${id}`, { headers: { range: `bytes=${wav.length}-` } })).status).toBe(416);
  });
  it('404 for an unknown id and for an image', async () => {
    const base = await serve();
    expect((await fetch(`${base}/voice/${'0'.repeat(64)}`)).status).toBe(404);
    const img = store.put(Buffer.from('png'), 'image/png');
    expect((await fetch(`${base}/voice/${img}`)).status).toBe(404);
  });
});

describe('POST /voice/<id>/text', () => {
  it('transcribes a stored recording in the given language', async () => {
    const langs: string[] = [];
    const base = await serve({ run: async (_p, lang) => { langs.push(lang); return ' said '; } });
    const id = store.put(makeWav({ seconds: 1 }), 'audio/wav');
    const r = await fetch(`${base}/voice/${id}/text?lang=ru`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: 'said', lang: 'ru' });
    expect(langs).toEqual(['ru']);
  });
  it('?detect=1 asks for detection and answers the language used; without it nothing is detected', async () => {
    const asked: (boolean | undefined)[] = [];
    const base = await serve({ run: async (_p, _l, detect) => { asked.push(detect); return { text: 'bonjour', lang: detect ? 'fr' : 'en' }; } });
    const id = store.put(makeWav({ seconds: 1 }), 'audio/wav');
    expect(await (await fetch(`${base}/voice/${id}/text?lang=en&detect=1`, { method: 'POST' })).json()).toEqual({ text: 'bonjour', lang: 'fr' });
    expect(await (await fetch(`${base}/voice/${id}/text?lang=en`, { method: 'POST' })).json()).toEqual({ text: 'bonjour', lang: 'en' });
    expect(await (await fetch(`${base}/voice/${id}/text?lang=en&detect=0`, { method: 'POST' })).json()).toEqual({ text: 'bonjour', lang: 'en' });
    expect(asked).toEqual([true, false, false]);
  });
  it('503 busy when the Whisper host\'s queue is full, 503 off when it was removed under the job, any other failure a 500', async () => {
    let n = 0;
    const base = await serve({ run: async () => { throw [new WhisperBusy('busy'), new WhisperOff('off'), new Error('down')][n++]!; } });
    const id = store.put(makeWav({ seconds: 1 }), 'audio/wav');
    const go = () => fetch(`${base}/voice/${id}/text?lang=en`, { method: 'POST' });
    const busy = await go();
    expect([busy.status, await busy.json()]).toEqual([503, { error: 'busy' }]);
    const off = await go();
    expect([off.status, await off.json()]).toEqual([503, { error: 'dictation is off' }]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await go()).status).toBe(500);
  });
  it('503 while Whisper is off, 404 for an unknown id, 400 for a bad lang', async () => {
    const id = store.put(makeWav({ seconds: 1 }), 'audio/wav');
    const off = await serve({ on: false });
    expect((await fetch(`${off}/voice/${id}/text?lang=en`, { method: 'POST' })).status).toBe(503);
    await new Promise<void>((done) => server!.close(() => done()));
    const base = await serve();
    expect((await fetch(`${base}/voice/${'0'.repeat(64)}/text?lang=en`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/voice/${id}/text?lang=English`, { method: 'POST' })).status).toBe(400);
  });
});

describe('transcribeVoice', () => {
  it('a long recording goes part by part, one at a time, joined by spaces', async () => {
    const id = store.put(makeWav({ seconds: 150 }), 'audio/wav');
    let running = 0, most = 0, n = 0;
    const text = await transcribeVoice(store, id, 'en', async (pcm) => {
      running++; most = Math.max(most, running);
      expect(pcm.length).toBeLessThanOrEqual(60 * 16000);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return `p${++n}`;
    });
    expect(text.text).toBe('p1 p2 p3');
    expect(most).toBe(1);
  });
  it('a failed part is tried once more, then the whole fails', async () => {
    const id = store.put(makeWav({ seconds: 1 }), 'audio/wav');
    let calls = 0;
    expect((await transcribeVoice(store, id, 'en', async () => { if (++calls === 1) throw new Error('flake'); return 'ok'; })).text).toBe('ok');
    await expect(transcribeVoice(store, id, 'en', async () => { throw new Error('down'); })).rejects.toThrow('down');
  });
  it('stops between parts once the caller is gone (a switch), without starting the next one', async () => {
    const id = store.put(makeWav({ seconds: 150 }), 'audio/wav');
    let alive = true, n = 0;
    await expect(transcribeVoice(store, id, 'en', async () => { n++; alive = false; return 'x'; }, () => alive)).rejects.toBeInstanceOf(VoiceFailure);
    expect(n).toBe(1);
  });
  it('a caller that goes while a part waits for Whisper aborts it (the part queued at the host is cancelled)', async () => {
    const id = store.put(makeWav({ seconds: 150 }), 'audio/wav');
    let alive = true, n = 0;
    let begun!: () => void;
    const started = new Promise<void>((resolve) => { begun = resolve; });
    let signal: AbortSignal | undefined;
    const gone = transcribeVoice(store, id, 'en', (_pcm, _lang, _detect, s) => {
      n++;
      signal = s;
      begun();
      return new Promise((_, reject) => s!.addEventListener('abort', () => reject(s!.reason), { once: true }));
    }, () => alive);
    const failed = expect(gone).rejects.toMatchObject({ why: 'failed', message: 'dropped' });
    await started;
    expect(signal!.aborted).toBe(false); // alive: nothing is aborted
    alive = false;
    await failed;
    expect(signal!.aborted).toBe(true);
    expect(n).toBe(1); // not retried, and the next part never started
  });
  it('a part still waiting its turn in the window\'s queue is dropped when the caller goes: it never reaches Whisper', async () => {
    const id = store.put(makeWav({ seconds: 1 }), 'audio/wav');
    let release!: () => void;
    const busy = queued(() => new Promise<void>((resolve) => { release = resolve; })); // another recording holds the queue
    let gone = false;
    let polled!: () => void;
    const sawIt = new Promise<void>((resolve) => { polled = resolve; });
    let calls = 0;
    const result = transcribeVoice(store, id, 'en', async () => { calls++; return 'x'; }, () => { if (gone) polled(); return !gone; });
    const dropped = expect(result).rejects.toMatchObject({ why: 'failed', message: 'dropped' });
    gone = true;
    await sawIt; // the caller's `alive` has said no, and its part is aborted
    release();
    await busy;
    await dropped;
    expect(calls).toBe(0);
  });
  it('a part that finds Whisper busy fails the message as `failed` and is not tried again; off is `off`', async () => {
    const id = store.put(makeWav({ seconds: 1 }), 'audio/wav');
    let calls = 0;
    await expect(transcribeVoice(store, id, 'en', async () => { calls++; throw new WhisperBusy('Whisper is busy'); })).rejects.toBeInstanceOf(VoiceBusy);
    expect(calls).toBe(1);
    await expect(transcribeVoice(store, id, 'en', async () => { calls++; throw new WhisperOff('Whisper is off'); })).rejects.toMatchObject({ why: 'off' });
    expect(calls).toBe(2);
  });
  it('a part is told its signal, and the signal does not abort while the caller is alive', async () => {
    const id = store.put(makeWav({ seconds: 1 }), 'audio/wav');
    let signal: AbortSignal | undefined;
    await transcribeVoice(store, id, 'en', async (_pcm, _lang, _detect, s) => { signal = s; return 'x'; });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });
  it('each part reaches Whisper as samples of -1..1', async () => {
    const id = store.put(makeWav({ seconds: 1 }), 'audio/wav');
    let peak = 0;
    await transcribeVoice(store, id, 'en', async (pcm) => { peak = Math.max(...pcm); return 'x'; });
    expect(peak).toBeGreaterThan(0.4);
    expect(peak).toBeLessThanOrEqual(1);
  });
  it('detects on the first part only and pins what it found for the rest', async () => {
    const id = store.put(makeWav({ seconds: 150 }), 'audio/wav');
    const calls: [string, boolean | undefined][] = [];
    const out = await transcribeVoice(store, id, 'en', async (_pcm, lang, detect) => {
      calls.push([lang, detect]);
      return { text: 'x', lang: detect ? 'fr' : lang };
    }, undefined, true);
    expect(calls).toEqual([['en', true], ['fr', false], ['fr', false]]);
    expect(out).toEqual({ text: 'x x x', lang: 'fr' });
  });
  it('without detect every part is in the asked language, and the answer says so', async () => {
    const id = store.put(makeWav({ seconds: 150 }), 'audio/wav');
    const calls: [string, boolean | undefined][] = [];
    const out = await transcribeVoice(store, id, 'de', async (_pcm, lang, detect) => { calls.push([lang, detect]); return 'x'; });
    expect(calls).toEqual([['de', false], ['de', false], ['de', false]]);
    expect(out.lang).toBe('de');
  });
  it('an unknown recording is a VoiceFailure', async () => {
    await expect(transcribeVoice(store, '0'.repeat(64), 'en', async () => 'x')).rejects.toBeInstanceOf(VoiceFailure);
  });
});

describe('through the window\'s http handler', () => {
  it('/voice/<id> is matched by prefix and a POST needs an allowed Origin', async () => {
    const hosts: string[] = [];
    const origins: string[] = [];
    const hub = new EventHub();
    server = http.createServer(httpHandler({
      hub, webDist: dir, info: () => ({}), allowedHosts: hosts, allowedOrigins: origins,
      extra: voiceRoutes({ hub, store, on: () => true, transcribe: async () => 'x' }),
    }));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    hosts.push(base.slice('http://'.length));
    origins.push(base);
    const id = store.put(makeWav({ seconds: 1 }), 'audio/wav');
    expect((await fetch(`${base}/voice/${id}`)).status).toBe(200);
    expect((await upload(base, makeWav({ seconds: 1 }))).status).toBe(403);
    expect((await upload(base, makeWav({ seconds: 1 }), { ...wavHeaders, origin: base })).status).toBe(200);
  });
});
