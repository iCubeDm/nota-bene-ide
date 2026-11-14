// `GET /remote`, `POST /remote/{config,pair,pair/cancel,revoke}`: the Remote tab's server side (keeper.ts does the work). Key tier,
// as every route; a paired phone never reaches them (device.ts goodPath).
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { EventHub } from '../hub.ts';
import { reportError } from '../errors.ts';
import { LegacyConnector, NotRunning, type RemoteKeeper } from './keeper.ts';

const MAX_BODY = 16 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > MAX_BODY) throw new SyntaxError('body too large');
    chunks.push(c);
  }
  const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

export type RemoteKeeperApi = Pick<RemoteKeeper, 'refresh' | 'setConfig' | 'pair' | 'cancelPair' | 'revoke'>;

/** `keeper` undefined: this window keeps no connector (a test server); every route answers 503. */
export function remoteRoutes(o: { hub: EventHub; keeper: RemoteKeeperApi | undefined }): Record<string, RequestListener> {
  const failed = (req: IncomingMessage, res: ServerResponse) => (e: unknown): void => {
    if (res.headersSent) return;
    if (e instanceof SyntaxError) return json(res, 400, { error: 'bad json' });
    if (e instanceof LegacyConnector) return json(res, 409, { error: 'legacy' });
    if (e instanceof NotRunning) return json(res, 409, { error: 'not running' });
    reportError(o.hub, req.url ?? '/remote', e);
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  };
  const route = (method: 'GET' | 'POST', h: (k: RemoteKeeperApi, req: IncomingMessage, res: ServerResponse) => Promise<void>): RequestListener => (req, res) => {
    if (req.method !== method && !(method === 'GET' && req.method === 'HEAD')) return json(res, 405, { error: 'method not allowed' });
    if (!o.keeper) return json(res, 503, { error: 'remote access is not available in this window' });
    h(o.keeper, req, res).catch(failed(req, res));
  };
  return {
    '/remote': route('GET', async (k, _req, res) => json(res, 200, await k.refresh())),
    '/remote/config': route('POST', async (k, req, res) => {
      const b = await readBody(req);
      if (b.relay !== undefined && typeof b.relay !== 'string') return json(res, 400, { error: 'relay must be a string' });
      if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be a boolean' });
      if (b.accessKey !== undefined && b.accessKey !== null && typeof b.accessKey !== 'string') return json(res, 400, { error: 'accessKey must be a string or null' });
      let r: Awaited<ReturnType<RemoteKeeperApi['setConfig']>>;
      try {
        r = await k.setConfig({
          ...(typeof b.relay === 'string' ? { relay: b.relay.trim() } : {}),
          ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}),
          ...(b.accessKey === null || typeof b.accessKey === 'string' ? { accessKey: b.accessKey === null ? null : b.accessKey.trim() } : {}),
        });
      } catch (e) {
        // a relay address checkRelay refused, or an access key parseAccessKey refused: the message says what is wrong
        if (e instanceof Error && !(e instanceof LegacyConnector) && /relay must be|not a URL|access key|pairing code/.test(e.message)) return json(res, 400, { error: e.message });
        throw e;
      }
      json(res, 200, r);
    }),
    '/remote/pair': route('POST', async (k, _req, res) => json(res, 200, await k.pair())),
    '/remote/pair/cancel': route('POST', async (k, _req, res) => {
      k.cancelPair();
      json(res, 200, { ok: true });
    }),
    '/remote/revoke': route('POST', async (k, req, res) => {
      const b = await readBody(req);
      if (typeof b.id !== 'string' || !b.id) return json(res, 400, { error: 'id must be a string' });
      json(res, 200, await k.revoke(b.id));
    }),
  };
}
