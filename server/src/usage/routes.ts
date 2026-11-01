// `GET /usage`, `POST /usage/reset`: the Usage tab's server side. Both are in the key tier (auth.ts).
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { USAGE_PERIODS, type Stats, type UsagePeriod, type UsageProvider, type UsageReport } from '@nota-bene/shared';
import { reportError } from '../errors.ts';
import type { EventHub } from '../hub.ts';
import type { RateLimitInfo } from '../stats.ts';
import { defaultSource, importUsage, type UsageSource } from './importer.ts';
import type { LimitRecord, SpendRecord } from './parse.ts';
import { buildReport } from './report.ts';
import { UsageStore } from './store.ts';

const IMPORT_EVERY_MS = 15_000;
const WINDOW_MINUTES = { five_hour: 300, seven_day: 10080 } as const;

const isProvider = (v: unknown): v is UsageProvider => v === 'claude' || v === 'codex';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** One provider's store and its import: never two at once, and not on every request. */
export class UsageService {
  private readonly store: UsageStore;
  private readonly source: UsageSource;
  private readonly onError: (e: unknown) => void;
  private readonly now: () => number;
  private running: Promise<void> | null = null;
  private lastImport = -Infinity;

  constructor(provider: UsageProvider, o: { store?: UsageStore; source?: UsageSource; onError?: (e: unknown) => void; now?: () => number } = {}) {
    this.store = o.store ?? new UsageStore(provider);
    this.source = o.source ?? defaultSource(provider);
    this.onError = o.onError ?? (() => {});
    this.now = o.now ?? Date.now;
  }

  /** Starts an import unless one runs or one just ended; the returned promise is for tests. */
  refresh(): Promise<void> {
    if (this.running) return this.running;
    if (this.now() - this.lastImport < IMPORT_EVERY_MS) return Promise.resolve();
    this.lastImport = this.now();
    this.running = importUsage(this.store, this.source).then(() => {}, this.onError).finally(() => { this.running = null; });
    return this.running;
  }

  async report(period: UsagePeriod): Promise<UsageReport> {
    void this.refresh();
    return buildReport(await this.store.load(), {
      provider: this.store.provider, period, trip: this.store.trip(), importing: this.running !== null, now: this.now(),
    });
  }

  reset(): void {
    this.store.resetTrip(this.now());
  }
}

/** What the meters read goes to the store: Claude keeps limit readings nowhere else. Only when one moved. */
export function limitRecorder(store: UsageStore, now: () => number = Date.now): (s: Stats) => void {
  const last = new Map<number, number>();
  let spent: number | undefined;
  return (s) => {
    const out: (LimitRecord | SpendRecord)[] = [];
    for (const [name, minutes] of Object.entries(WINDOW_MINUTES)) {
      const l = s.limits?.[name as keyof typeof WINDOW_MINUTES];
      if (!l || last.get(minutes) === l.utilization) continue;
      last.set(minutes, l.utilization);
      out.push({ k: 'l', ts: now(), minutes, pct: l.utilization, resets: l.resets_at ? Date.parse(l.resets_at) : null });
    }
    if (s.extra && s.extra.used !== spent) {
      spent = s.extra.used;
      out.push({ k: 'x', ts: now(), ...s.extra });
    }
    try { store.append(out); } catch { /* the meters go on without the record */ }
  };
}

/** A limit the SDK refused, once per window. With extra usage on the work goes on, and no transcript says the limit was hit. */
export function hitRecorder(store: UsageStore, now: () => number = Date.now): (info: unknown) => void {
  const seen = new Set<string>();
  return (info) => {
    const { status, rateLimitType: type, resetsAt, isUsingOverage } = info as RateLimitInfo;
    const kind = type === 'five_hour' ? '5h' : type?.startsWith('seven_day') ? 'week' : null;
    const overage = isUsingOverage === true && (type === 'five_hour' || type === 'seven_day'); // a limit of one model leaves the others free
    const key = `${kind}:${resetsAt}:${overage}`;
    if (status !== 'rejected' || !kind || seen.has(key)) return;
    seen.add(key);
    try {
      store.append([{ k: 'h', ts: now(), kind, ...(resetsAt ? { resets: resetsAt * 1000 } : {}), ...(overage ? { overage } : {}) }]);
    } catch { /* the work goes on without the record */ }
  };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  return v && typeof v === 'object' ? v as Record<string, unknown> : {};
}

export function usageRoutes(o: { hub: EventHub; service?: (p: UsageProvider) => UsageService }): Record<string, RequestListener> {
  const services = new Map<UsageProvider, UsageService>();
  const service = o.service ?? ((p: UsageProvider) => {
    let s = services.get(p);
    if (!s) services.set(p, s = new UsageService(p, { onError: (e) => reportError(o.hub, '/usage', e) }));
    return s;
  });
  const failed = (req: IncomingMessage, res: ServerResponse) => (e: unknown) => {
    reportError(o.hub, req.url ?? '/usage', e);
    if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  };
  return {
    '/usage': (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const provider = q.get('provider'), period = q.get('period') ?? 'trip';
      if (!isProvider(provider) || !(USAGE_PERIODS as readonly string[]).includes(period)) return json(res, 400, { error: 'bad provider or period' });
      service(provider).report(period as UsagePeriod).then((r) => json(res, 200, r), failed(req, res));
    },
    '/usage/reset': (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      readBody(req).then((b) => {
        if (!isProvider(b.provider)) return json(res, 400, { error: 'bad provider' });
        service(b.provider).reset();
        json(res, 200, { ok: true });
      }).catch((e: unknown) => (e instanceof SyntaxError ? json(res, 400, { error: 'bad json' }) : failed(req, res)(e)));
    },
  };
}
