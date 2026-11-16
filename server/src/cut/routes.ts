// `GET /cut/export?path=`, `POST /cut/export {path, mode}`, `POST /cut/export/cancel {path}`: the video editor's export.
// A long job polled over HTTP, as the Whisper install is: the start answers 202, the page asks for the state until it ends.
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { readCapped } from '../attachments.ts';
import type { EventHub } from '../hub.ts';
import { reportError } from '../errors.ts';
import { EXPORT_MODES, type ExportMode } from './args.ts';
import { CutExportError, type CutExporter } from './exporter.ts';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** a start or cancel body is a path and a mode: far below this */
const MAX_BODY = 64 * 1024;

class TooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readCapped(req, MAX_BODY);
  if (bytes === null) throw new TooLarge();
  const v: unknown = JSON.parse(bytes.toString('utf8') || '{}');
  return v && typeof v === 'object' ? v as Record<string, unknown> : {};
}

const isMode = (v: unknown): v is ExportMode => EXPORT_MODES.includes(v as ExportMode);
const isPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096;

export function cutRoutes(o: { hub: EventHub; exporter: Pick<CutExporter, 'ffmpegState' | 'job' | 'start' | 'cancel'> }): Record<string, RequestListener> {
  const failed = (req: IncomingMessage, res: ServerResponse) => (e: unknown): void => {
    if (e instanceof TooLarge) {
      // what is left of the body is drained, then the connection dropped if it never ends (as refuseTooLarge does)
      req.resume();
      setTimeout(() => { if (!req.complete) req.destroy(); }, 2000).unref();
      return json(res, 413, { error: 'too-large' });
    }
    if (e instanceof SyntaxError) return json(res, 400, { error: 'bad json' });
    if (e instanceof CutExportError) return json(res, e.status, { error: e.code, detail: e.detail, ...(e.issues && { issues: e.issues }) });
    reportError(o.hub, req.url ?? '/cut/export', e);
    if (!res.headersSent) json(res, 500, { error: 'internal', detail: e instanceof Error ? e.message : String(e) });
  };
  const post = (h: (body: Record<string, unknown>, res: ServerResponse) => void | Promise<void>): RequestListener => (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    readBody(req).then((b) => h(b, res)).catch(failed(req, res));
  };
  return {
    '/cut/export': (req, res) => {
      if (req.method === 'POST') {
        return post(async (b) => {
          if (!isPath(b.path)) return json(res, 400, { error: 'path must be an edit' });
          if (!isMode(b.mode)) return json(res, 400, { error: `mode must be one of ${EXPORT_MODES.join(', ')}` });
          json(res, 202, { job: await o.exporter.start(b.path, b.mode) });
        })(req, res);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
      const p = new URL(req.url ?? '', 'http://x').searchParams.get('path');
      if (!isPath(p)) return json(res, 400, { error: 'path must be an edit' });
      // too old an ffmpeg is no ffmpeg for the export; the page says why
      const ff = o.exporter.ffmpegState();
      json(res, 200, { ffmpeg: ff.ok, ...(!ff.ok && ff.reason === 'old-ffmpeg' && { ffmpegProblem: 'old', ffmpegVersion: ff.version }), job: o.exporter.job(p) });
    },
    '/cut/export/cancel': post((b, res) => {
      if (!isPath(b.path)) return json(res, 400, { error: 'path must be an edit' });
      if (!o.exporter.cancel(b.path)) return json(res, 404, { error: 'not running' });
      json(res, 200, { ok: true });
    }),
  };
}
