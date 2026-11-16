import fs from 'node:fs';
import http, { type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../hub.ts';
import { CutExportError, type CutExporter, type ExportJob } from './exporter.ts';
import { cutRoutes } from './routes.ts';

let root: string;
let server: http.Server | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-cut-routes-')); });
afterEach(async () => {
  await new Promise<void>((done) => { if (server) server.close(() => done()); else done(); });
  server = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

const JOB: ExportJob = { edit: 'a.nbcut.json', mode: 'mp4', phase: 'running', progress: 0.5, output: 'exports/a.mp4' };
type Fake = Pick<CutExporter, 'ffmpegState' | 'job' | 'start' | 'cancel'>;
const calls: unknown[][] = [];
const fake = (o: Partial<Fake> = {}): Fake => ({
  ffmpegState: () => ({ ok: true }),
  job: (e) => (calls.push(['job', e]), e === 'a.nbcut.json' ? JOB : null),
  start: async (e, m) => (calls.push(['start', e, m]), { ...JOB, mode: m }),
  cancel: (e) => (calls.push(['cancel', e]), e === 'a.nbcut.json'),
  ...o,
});
async function serve(exporter: Fake): Promise<string> {
  const routes = cutRoutes({ hub: new EventHub(), exporter });
  server = http.createServer(((req, res) => routes[req.url!.split('?')[0]!]!(req, res)) as RequestListener);
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const post = (base: string, p: string, body: unknown) => fetch(base + p, { method: 'POST', body: JSON.stringify(body) });

describe('cut export routes', () => {
  it('GET /cut/export?path=: whether ffmpeg is found, and the edit\'s last export', async () => {
    const base = await serve(fake());
    expect(await (await fetch(`${base}/cut/export?path=a.nbcut.json`)).json()).toEqual({ ffmpeg: true, job: JOB });
    expect(await (await fetch(`${base}/cut/export?path=b.nbcut.json`)).json()).toEqual({ ffmpeg: true, job: null });
    const none = await serve(fake({ ffmpegState: () => ({ ok: false, reason: 'no-ffmpeg' }) }));
    expect(await (await fetch(`${none}/cut/export?path=b.nbcut.json`)).json()).toEqual({ ffmpeg: false, job: null });
    // too old an ffmpeg: unusable, and why
    const old = await serve(fake({ ffmpegState: () => ({ ok: false, reason: 'old-ffmpeg', version: '4.3.1' }) }));
    expect(await (await fetch(`${old}/cut/export?path=b.nbcut.json`)).json()).toEqual({ ffmpeg: false, ffmpegProblem: 'old', ffmpegVersion: '4.3.1', job: null });
    expect((await fetch(`${base}/cut/export`)).status).toBe(400);
    expect((await fetch(`${base}/cut/export/cancel?path=a.nbcut.json`)).status).toBe(405);
  });

  it('POST /cut/export starts (202 with the job); a bad mode or path is 400; a refusal keeps its status and code', async () => {
    const base = await serve(fake());
    const r = await post(base, '/cut/export', { path: 'a.nbcut.json', mode: 'wav' });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ job: { ...JOB, mode: 'wav' } });
    expect((await post(base, '/cut/export', { path: 'a.nbcut.json', mode: 'avi' })).status).toBe(400);
    expect((await post(base, '/cut/export', { mode: 'mp4' })).status).toBe(400);
    expect((await fetch(`${base}/cut/export`, { method: 'POST', body: '{' })).status).toBe(400);
    const refusing = await serve(fake({ start: async () => { throw new CutExportError(403, 'outside-project', '../x.mp4'); } }));
    const no = await post(refusing, '/cut/export', { path: 'a.nbcut.json', mode: 'mp4' });
    expect(no.status).toBe(403);
    expect(await no.json()).toEqual({ error: 'outside-project', detail: '../x.mp4' });
    const issues = [{ path: 'clips[0].out', code: 'out-before-in', clip: 'c' }];
    const invalid = await serve(fake({ start: async () => { throw new CutExportError(422, 'invalid-edit', 'clips[0].out: out-before-in', issues); } }));
    const bad = await post(invalid, '/cut/export', { path: 'a.nbcut.json', mode: 'mp4' });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: 'invalid-edit', detail: 'clips[0].out: out-before-in', issues });
  });

  it('a POST body over the cap is 413; an unexpected failure is 500 with the code internal and the message as detail', async () => {
    const base = await serve(fake());
    const big = await fetch(`${base}/cut/export`, { method: 'POST', body: JSON.stringify({ path: 'a.nbcut.json', mode: 'mp4', pad: 'x'.repeat(100_000) }) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'too-large' });
    expect((await fetch(`${base}/cut/export/cancel`, { method: 'POST', body: 'x'.repeat(100_000) })).status).toBe(413);
    const broken = await serve(fake({ start: async () => { throw new Error('disk on fire'); } }));
    const r = await post(broken, '/cut/export', { path: 'a.nbcut.json', mode: 'mp4' });
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'internal', detail: 'disk on fire' });
  });

  it('POST /cut/export/cancel: 200 when one ran, 404 when none', async () => {
    const base = await serve(fake());
    expect((await post(base, '/cut/export/cancel', { path: 'a.nbcut.json' })).status).toBe(200);
    expect((await post(base, '/cut/export/cancel', { path: 'b.nbcut.json' })).status).toBe(404);
  });
});
