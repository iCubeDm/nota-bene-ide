import http, { type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EventHub } from '../hub.ts';
import type { UsageRecord } from './parse.ts';
import { hitRecorder, usageRoutes, type UsageService } from './routes.ts';
import type { UsageStore } from './store.ts';

let server: http.Server | undefined;
afterEach(() => new Promise<void>((done) => { if (server) server.close(() => done()); else done(); }));

async function serve(service: Partial<UsageService>): Promise<string> {
  const routes = usageRoutes({ hub: new EventHub(), service: () => service as UsageService });
  server = http.createServer(((req, res) => routes[req.url!.split('?')[0]!]!(req, res)) as RequestListener);
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('hitRecorder', () => {
  const recorder = () => {
    const got: UsageRecord[] = [];
    let t = 1000;
    const record = hitRecorder({ append: (r: readonly UsageRecord[]) => got.push(...r) } as unknown as UsageStore, () => t++);
    return { got, record };
  };

  it('a rejection is a hit of its window, and the work may go on: extra usage says the same', () => {
    const { got, record } = recorder();
    record({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 50 });
    record({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 60, isUsingOverage: true, overageStatus: 'allowed' });
    record({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 70 });
    expect(got).toEqual([
      { k: 'h', ts: 1000, kind: '5h', resets: 50_000 },
      { k: 'h', ts: 1001, kind: 'week', resets: 60_000 },
      { k: 'h', ts: 1002, kind: 'week', resets: 70_000 },
    ]);
  });

  it('what is allowed, and the extra usage limit itself, is no hit', () => {
    const { got, record } = recorder();
    record({ status: 'allowed', rateLimitType: 'seven_day', resetsAt: 60 });
    record({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 60 });
    record({ status: 'rejected', rateLimitType: 'overage', resetsAt: 60 });
    record({ status: 'rejected' });
    expect(got).toEqual([]);
  });

  it('one hit per window, however often the SDK repeats it', () => {
    const { got, record } = recorder();
    for (let i = 0; i < 3; i++) record({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 60 });
    expect(got).toHaveLength(1);
  });
});

describe('/usage', () => {
  it('answers the report of the period asked for, trip by default', async () => {
    const asked: string[] = [];
    const base = await serve({ report: (p) => { asked.push(p); return Promise.resolve({ period: p } as never); } });
    expect((await (await fetch(`${base}/usage?provider=claude&period=7d`)).json())).toEqual({ period: '7d' });
    await fetch(`${base}/usage?provider=codex`);
    expect(asked).toEqual(['7d', 'trip']);
  });

  it('refuses an unknown provider or period and any write', async () => {
    const base = await serve({});
    expect((await fetch(`${base}/usage?provider=x`)).status).toBe(400);
    expect((await fetch(`${base}/usage?provider=claude&period=1y`)).status).toBe(400);
    expect((await fetch(`${base}/usage?provider=claude`, { method: 'POST' })).status).toBe(405);
  });

  it('a failing report is a 500, not a hang', async () => {
    const base = await serve({ report: () => Promise.reject(new Error('disk')) });
    expect((await fetch(`${base}/usage?provider=claude`)).status).toBe(500);
  });
});

describe('/usage/reset', () => {
  const post = (base: string, body: string) => fetch(`${base}/usage/reset`, { method: 'POST', body });

  it('resets the provider it names', async () => {
    let resets = 0;
    const base = await serve({ reset: () => { resets++; } });
    expect((await post(base, '{"provider":"codex"}')).status).toBe(200);
    expect(resets).toBe(1);
  });

  it('refuses a bad body and GET', async () => {
    const base = await serve({ reset: () => { throw new Error('no'); } });
    expect((await post(base, '{"provider":"x"}')).status).toBe(400);
    expect((await post(base, 'nope')).status).toBe(400);
    expect((await fetch(`${base}/usage/reset`)).status).toBe(405);
  });
});
