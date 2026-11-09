// `GET /dictation`, `POST /dictation/{install,on,remove}`: Settings → Dictation's server side for the optional Whisper install.
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { EventHub } from '../hub.ts';
import { readPrefs, setWhisperPref } from '../prefs.ts';
import { installWhisper, removeWhisper, whisperPhase } from './install.ts';
import { resetTranscriber, transcribe as defaultTranscribe } from './transcribe.ts';
import { pcmFromWav, WavError } from './wav.ts';
import { WHISPER_MODEL, WHISPER_SIZE_MB } from './whisper.ts';
import { reportError } from '../errors.ts';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  return v && typeof v === 'object' ? v as Record<string, unknown> : {};
}

/** Two minutes of 16 kHz 16-bit mono is 3.84 MB. */
const MAX_AUDIO = 4 * 1024 * 1024;

/** The body up to `max` bytes; null once it is larger (the rest is dropped, not buffered). */
async function readAudio(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > max) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export function dictationRoutes(o: { hub: EventHub; install?: Parameters<typeof installWhisper>[0]; transcribe?: (pcm: Float32Array, lang: string) => Promise<string> }): Record<string, RequestListener> {
  const post = (h: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): RequestListener => (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    Promise.resolve(h(req, res)).catch((e: unknown) => {
      if (e instanceof SyntaxError) return json(res, 400, { error: 'bad json' });
      reportError(o.hub, req.url ?? '/dictation', e);
      if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  };
  const run = o.transcribe ?? defaultTranscribe;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    '/dictation': (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
      const phase = whisperPhase();
      json(res, 200, { on: readPrefs().whisper === true && phase === 'ready', phase, sizeMb: WHISPER_SIZE_MB, model: WHISPER_MODEL });
    },
    '/dictation/install': post((_req, res) => {
      if (whisperPhase() === 'installing') return json(res, 409, { error: 'already installing' });
      // the failure is the phase `failed`; nobody awaits the install
      installWhisper(o.install).catch(() => {});
      json(res, 202, { ok: true });
    }),
    '/dictation/on': post(async (req, res) => {
      const b = await readBody(req);
      if (typeof b.on !== 'boolean') return json(res, 400, { error: 'on must be a boolean' });
      if (b.on && whisperPhase() !== 'ready') return json(res, 409, { error: 'not installed' });
      setWhisperPref(b.on);
      json(res, 200, { ok: true });
    }),
    '/dictation/remove': post((_req, res) => {
      if (!removeWhisper()) return json(res, 409, { error: 'installing' });
      resetTranscriber();
      setWhisperPref(false);
      json(res, 200, { ok: true });
    }),
     '/dictation/transcribe': post(async (req, res) => {
      if (readPrefs().whisper !== true || whisperPhase() !== 'ready') return json(res, 503, { error: 'dictation is off' });
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('audio/wav')) return json(res, 415, { error: 'audio/wav only' });
      const declared = Number(req.headers['content-length']);
      const body = declared > MAX_AUDIO ? null : await readAudio(req, MAX_AUDIO);
      if (!body) return json(res, 413, { error: 'audio too long' });
      let pcm: Float32Array;
      try { pcm = pcmFromWav(body); } catch (e) {
        if (e instanceof WavError) return json(res, 400, { error: e.message });
        throw e;
      }
      const lang = new URL(req.url ?? '', 'http://x').searchParams.get('lang') || 'en';
      // one at a time: the model is single-threaded and memory-heavy
      const job = queue.then(() => run(pcm, lang));
      queue = job.catch(() => {});
      json(res, 200, { text: await job });
    }),
  };
}
