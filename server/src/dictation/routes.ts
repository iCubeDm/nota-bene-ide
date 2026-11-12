// `GET /dictation`, `POST /dictation/{install,on,lang,remove,transcribe}`: Settings → Dictation's server side for the optional Whisper install.
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { EventHub } from '../hub.ts';
import { isDictationLang, readPrefs, setDictationLangPref, setWhisperPref } from '../prefs.ts';
import { installWhisper, removeWhisper, whisperDir, whisperPhase, withdrawWhisper } from './install.ts';
import { hostClient, WhisperBusy, WhisperOff, type HostClient } from './hostClient.ts';
import { queued, resetTranscriber, spokenOf, transcribeWith as defaultTranscribe, type SpokenOrText } from './transcribe.ts';
import { pcmFromWav, WavError } from './wav.ts';
import { MAX_AUDIO, WHISPER_DISK_MB, WHISPER_DOWNLOAD_MB, WHISPER_MODEL } from './whisper.ts';
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

/** An ISO 639 language code, as Whisper takes it (en, ru, yue). */
export const LANG = /^[a-z]{2,3}$/;

/** Whisper is installed, ready and switched on. */
export const whisperOn = (): boolean => readPrefs().whisper === true && whisperPhase() === 'ready';

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

/** What a page learns of the Whisper host: it is loaded (has the model in memory), how many jobs wait, whether one runs. */
export type HostState = { loaded: boolean; queued: number; running: boolean };

export function dictationRoutes(o: { hub: EventHub; install?: Parameters<typeof installWhisper>[0]; transcribe?: (pcm: Float32Array, lang: string, detect?: boolean, signal?: AbortSignal) => Promise<SpokenOrText>; host?: Pick<HostClient, 'status' | 'stopHost'> }): Record<string, RequestListener> {
  /** What an async handler's failure becomes: a 400 for bad JSON, else it is reported and answered 500. */
  const failed = (req: IncomingMessage, res: ServerResponse) => (e: unknown): void => {
    if (e instanceof SyntaxError) return json(res, 400, { error: 'bad json' });
    reportError(o.hub, req.url ?? '/dictation', e);
    if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  };
  const post = (h: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): RequestListener => (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    Promise.resolve(h(req, res)).catch(failed(req, res));
  };
  const run = o.transcribe ?? defaultTranscribe;
  const host = o.host ?? hostClient;
  /** The running host's state, or null: none running, or one that cannot be asked (that is no failure of this request). */
  const hostState = async (): Promise<HostState | null> => {
    try {
      const h = await host.status();
      return h && { loaded: h.loaded, queued: h.queued, running: h.running };
    } catch { return null; }
  };
  return {
    '/dictation': (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
      // the host's state is asked first: the rest is read after it, so that the answer is as fresh as it can be
      hostState().then((state) => {
        const phase = whisperPhase();
        json(res, 200, { on: readPrefs().whisper === true && phase === 'ready', phase, downloadMb: WHISPER_DOWNLOAD_MB, diskMb: WHISPER_DISK_MB, dir: whisperDir(), model: WHISPER_MODEL, dictationLang: readPrefs().dictationLang ?? 'auto', host: state });
      }).catch(failed(req, res));
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
    '/dictation/lang': post(async (req, res) => {
      const b = await readBody(req);
      if (!isDictationLang(b.lang)) return json(res, 400, { error: 'lang must be auto or a language code' });
      setDictationLangPref(b.lang);
      json(res, 200, { ok: true });
    }),
    '/dictation/remove': post(async (_req, res) => {
      // first of all Whisper is off and the install no longer reads as ready (a refusal, while an install runs, stops nothing): a
      // dictation that passed its gate before, or a job that retries after the host is stopped, then finds Whisper off instead of
      // starting a host (or a load) from files that are about to go
      if (!withdrawWhisper()) return json(res, 409, { error: 'installing' });
      setWhisperPref(false);
      // the Whisper host serves from this install: it stops next (jobs waiting for it fail as `off`), so that no process goes on
      // holding a model that cannot be asked for. A host that cannot be stopped is told, and the removal goes on.
      try { await host.stopHost('removed'); } catch (e) { reportError(o.hub, 'whisper-host', e); }
      if (!removeWhisper()) return json(res, 409, { error: 'installing' });
      resetTranscriber();
      json(res, 200, { ok: true });
    }),
    '/dictation/transcribe': post(async (req, res) => {
      if (!whisperOn()) return json(res, 503, { error: 'dictation is off' });
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('audio/wav')) return json(res, 415, { error: 'audio/wav only' });
      const q = new URL(req.url ?? '', 'http://x').searchParams;
      const lang = q.get('lang') || 'en';
      if (!LANG.test(lang)) return json(res, 400, { error: 'bad lang' });
      const detect = q.get('detect') === '1';
      // the client left before the answer (a closed tab, a dropped phone): its job is cancelled, not transcribed for nobody
      const gone = new AbortController();
      res.on('close', () => { if (!res.writableFinished) gone.abort(); });
      const declared = Number(req.headers['content-length']);
      const body = declared > MAX_AUDIO ? null : await readAudio(req, MAX_AUDIO);
      if (!body) return json(res, 413, { error: 'audio too long' });
      let pcm: Float32Array;
      try { pcm = pcmFromWav(body); } catch (e) {
        if (e instanceof WavError) return json(res, 400, { error: e.message });
        throw e;
      }
      let got: ReturnType<typeof spokenOf>;
      try {
        got = spokenOf(await queued(() => run(pcm, lang, detect, gone.signal), gone.signal));
      } catch (e) {
        if (gone.signal.aborted) return;
        if (e instanceof WhisperBusy) return json(res, 503, { error: 'busy' });
        if (e instanceof WhisperOff) return json(res, 503, { error: 'dictation is off' });
        throw e;
      }
      json(res, 200, { text: got.text, lang: got.lang ?? lang });
    }),
  };
}
