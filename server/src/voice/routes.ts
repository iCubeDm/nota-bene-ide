// `POST /voice`, `GET /voice/<id>`, `POST /voice/<id>/text`: the recordings of voice messages and of comments' clips,
// kept in the attachment store beside the images.
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { VOICE_MAX_MS } from '@nota-bene/shared';
import { readCapped, refuseTooLarge, type AttachmentStore } from '../attachments.ts';
import { LANG, whisperOn } from '../dictation/routes.ts';
import { pcmFromWav, WavError } from '../dictation/wav.ts';
import { reportError } from '../errors.ts';
import type { EventHub } from '../hub.ts';
import { parseRange } from '../range.ts';
import { transcribeVoice, VoiceFailure, type Transcribe } from './transcribe.ts';
import { msOf, waveOf } from './wave.ts';

/** Ten minutes of 16 kHz 16-bit mono is 19.2 MB. */
export const MAX_VOICE_BYTES = 20 * 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function voiceRoutes(o: { hub: EventHub; store: AttachmentStore; on?: () => boolean; transcribe?: Transcribe }): Record<string, RequestListener> {
  const on = o.on ?? whisperOn;
  const fail = (req: IncomingMessage, res: ServerResponse, e: unknown) => {
    reportError(o.hub, req.url ?? '/voice', e);
    if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    else res.destroy();
  };
  const serve = (req: IncomingMessage, res: ServerResponse, id: string) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    const found = o.store.get(id);
    if (!found || found.mediaType !== 'audio/wav') return json(res, 404, { error: 'not found' });
    const size = found.bytes.length;
    const head = {
      'content-type': 'audio/wav',
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cross-origin-resource-policy': 'same-origin',
    };
    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return res.end();
    }
    const body = range ? found.bytes.subarray(range.start, range.end + 1) : found.bytes;
    res.writeHead(range ? 206 : 200, {
      ...head,
      'content-length': body.length,
      ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${size}` } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const text = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const lang = new URL(req.url ?? '', 'http://x').searchParams.get('lang') || 'en';
    if (!LANG.test(lang)) return json(res, 400, { error: 'bad lang' });
    if (!on()) return json(res, 503, { error: 'dictation is off' });
    req.resume(); // no body is read
    try {
      json(res, 200, { text: await transcribeVoice(o.store, id, lang, o.transcribe) });
    } catch (e) {
      if (e instanceof VoiceFailure) return json(res, 404, { error: e.message });
      throw e;
    }
  };
  return {
    '/voice': (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('audio/wav')) return json(res, 415, { error: 'audio/wav only' });
      void (async () => {
        try {
          const bytes = await readCapped(req, MAX_VOICE_BYTES);
          if (bytes === null) return refuseTooLarge(req, res, 'recording too large');
          let pcm: Float32Array;
          try { pcm = pcmFromWav(bytes); } catch (e) {
            if (e instanceof WavError) return json(res, 400, { error: e.message });
            throw e;
          }
          if (pcm.length === 0) return json(res, 400, { error: 'empty recording' });
          const ms = msOf(pcm);
          if (ms > VOICE_MAX_MS) return json(res, 413, { error: 'recording too long' });
          json(res, 200, { id: o.store.put(bytes, 'audio/wav'), ms, wave: waveOf(pcm) });
        } catch (e) {
          fail(req, res, e);
        }
      })();
    },
    // GET /voice/<id> and POST /voice/<id>/text: http.ts matches this key by prefix
    '/voice/': (req, res) => {
      const m = /^\/voice\/([0-9a-f]{64})(\/text)?$/.exec((req.url ?? '').split('?')[0]!);
      if (!m) return json(res, 404, { error: 'not found' });
      if (!m[2]) return serve(req, res, m[1]!);
      text(req, res, m[1]!).catch((e: unknown) => fail(req, res, e));
    },
  };
}
