import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cut } from '@nota-bene/shared/cut';
import { CutExporter, CutExportError, type ExportJob } from './exporter.ts';
import { findFfmpeg } from './ffmpeg.ts';

// A stand-in for ffmpeg: it logs its argv and acts on the first input's text. OK writes the output after reporting
// progress; FAIL prints to stderr and exits 1; HANG reports half the length and never ends.
const FAKE = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'spawns.log'), JSON.stringify({ argv: a, env: Object.keys(process.env), pid: process.pid }) + '\\n');
const body = fs.readFileSync(a[a.indexOf('-i') + 1], 'utf8');
const out = a[a.length - 1];
if (body.startsWith('FAIL')) { for (let i = 1; i <= 20; i++) console.error('line ' + i); console.error('Error: boom'); process.exit(1); }
console.log('frame=1\\nout_time_us=1000000\\nprogress=continue');
if (body.startsWith('HANG')) { fs.writeFileSync(out, 'partial'); setInterval(() => {}, 1000); }
else setTimeout(() => { fs.writeFileSync(out, 'RENDERED'); console.log('out_time_us=2000000\\nprogress=end'); process.exit(0); }, 100);
`;

let dir: string;
let fake: string;
let root: string;
const exporters: CutExporter[] = [];
const spawns = () => {
  try { return fs.readFileSync(path.join(path.dirname(fake), 'spawns.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; env: string[]; pid: number }); } catch { return []; }
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const make = (o: Partial<ConstructorParameters<typeof CutExporter>[0]> = {}) => {
  const e = new CutExporter({ root: () => root, ffmpeg: () => fake, probe: async () => ({ video: true, audio: true }), version: () => null, graceMs: 200, ...o });
  exporters.push(e);
  return e;
};
/** An edit of one 2 s clip of `src`, written as `rel`. */
const edit = (rel: string, src = 'media/a.mp4', patch: (c: Cut) => void = () => {}) => {
  const c: Cut = { version: 1, width: 64, height: 36, fps: 10, tracks: [{ id: 'v', kind: 'video' }], clips: [{ id: 'c', track: 'v', src, at: 0, out: 2 }] };
  patch(c);
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), JSON.stringify(c));
  return rel;
};
const media = (name: string, body: string) => {
  fs.mkdirSync(path.join(root, 'media'), { recursive: true });
  fs.writeFileSync(path.join(root, 'media', name), body);
};
const refusal = async (p: Promise<unknown>): Promise<{ status: number; code: string; detail: string; issues?: CutExportError['issues'] }> => {
  try { await p; } catch (e) {
    if (e instanceof CutExportError) return { status: e.status, code: e.code, detail: e.detail, issues: e.issues };
    throw e;
  }
  throw new Error('not refused');
};

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-cut-export-')));
  fake = path.join(dir, 'bin', 'ffmpeg');
  fs.mkdirSync(path.dirname(fake));
  fs.writeFileSync(fake, FAKE, { mode: 0o755 });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
beforeEach(() => {
  root = path.join(dir, `proj${++n}`);
  fs.mkdirSync(root);
  media('a.mp4', 'OK');
});
afterEach(() => { while (exporters.length) exporters.pop()!.dispose(); });

describe('CutExporter', () => {
  it('runs ffmpeg with an argument list, reports progress, writes exports/<name>.mp4 through a temp file', async () => {
    process.env.NB_TEST_SECRET = 'x';
    const e = make();
    const job = await e.start(edit('cuts/My edit.nbcut.json'), 'mp4');
    expect(job).toMatchObject({ edit: 'cuts/My edit.nbcut.json', mode: 'mp4', phase: 'running', output: 'exports/My edit.mp4' });
    await until(() => e.job('cuts/My edit.nbcut.json')?.phase === 'done');
    expect(fs.readFileSync(path.join(root, 'exports', 'My edit.mp4'), 'utf8')).toBe('RENDERED');
    expect(e.job('cuts/My edit.nbcut.json')!.progress).toBe(1);
    // nothing but the result is left in exports/
    expect(fs.readdirSync(path.join(root, 'exports'))).toEqual(['My edit.mp4']);
    const argv = spawns().at(-1)!.argv;
    expect(argv).toContain(path.join(root, 'media', 'a.mp4'));
    expect(argv.at(-1)).toMatch(/exports[\\/]\.My edit\.mp4\.[0-9a-f]+\.part$/);
    expect(spawns().at(-1)!.env).not.toContain('NB_TEST_SECRET');
    delete process.env.NB_TEST_SECRET;
  });

  it('progress is out_time over the edit length while it runs', async () => {
    media('a.mp4', 'HANG');
    const e = make();
    await e.start(edit('x.nbcut.json', 'media/a.mp4', (c) => { c.clips[0]!.out = 4; }), 'wav');
    await until(() => (e.job('x.nbcut.json')?.progress ?? 0) > 0);
    expect(e.job('x.nbcut.json')).toMatchObject({ phase: 'running', progress: 0.25, output: 'exports/x.wav' });
  });

  it('one running export per edit; cancel kills only its child, leaves no file and allows a new start', async () => {
    media('a.mp4', 'HANG');
    const e = make();
    const rel = edit('x.nbcut.json');
    await e.start(rel, 'mp4');
    expect(await refusal(e.start(rel, 'wav'))).toMatchObject({ status: 409, code: 'running' });
    await until(() => spawns().length > 0 && fs.readdirSync(path.join(root, 'exports')).length > 0);
    const pid = spawns().at(-1)!.pid;
    expect(e.cancel(rel)).toBe(true);
    await until(() => e.job(rel)?.phase === 'cancelled');
    await until(() => !alive(pid));
    expect(fs.readdirSync(path.join(root, 'exports'))).toEqual([]);
    expect(e.cancel(rel)).toBe(false);
    media('a.mp4', 'OK');
    await e.start(rel, 'mp4');
    await until(() => e.job(rel)?.phase === 'done');
  });

  it('a failure carries the last lines of ffmpeg stderr and removes the temp file', async () => {
    media('a.mp4', 'FAIL');
    const e = make();
    await e.start(edit('x.nbcut.json'), 'mp4');
    await until(() => e.job('x.nbcut.json')?.phase === 'failed');
    const err = e.job('x.nbcut.json')!.error!;
    expect(err.split('\n').at(-1)).toBe('Error: boom');
    expect(err).not.toContain('line 1\n');
    expect(fs.readdirSync(path.join(root, 'exports'))).toEqual([]);
  });

  it('one running export per output: an edit of the same name in another folder is refused while the first runs', async () => {
    media('a.mp4', 'HANG');
    const e = make();
    await e.start(edit('one/x.nbcut.json'), 'mp4');
    expect(await refusal(e.start(edit('two/x.nbcut.json'), 'mp4'))).toMatchObject({ status: 409, code: 'output-busy', detail: 'exports/x.mp4' });
    // another format is another file
    await e.start(edit('two/x.nbcut.json'), 'wav');
    expect(e.cancel('one/x.nbcut.json')).toBe(true);
    await until(() => e.job('one/x.nbcut.json')?.phase === 'cancelled');
    e.cancel('two/x.nbcut.json');
    await until(() => e.job('two/x.nbcut.json')?.phase === 'cancelled');
    media('a.mp4', 'OK');
    await e.start('two/x.nbcut.json', 'mp4');
    await until(() => e.job('two/x.nbcut.json')?.phase === 'done');
  });

  it('sources are probed at most 4 at a time; a video file without a picture stream is told to be no picture', async () => {
    let now = 0;
    let most = 0;
    const probe = async (_ff: string, file: string) => {
      most = Math.max(most, ++now);
      await new Promise((r) => setTimeout(r, 20));
      now--;
      return { video: !file.endsWith('voice.mp4'), audio: true };
    };
    for (let i = 0; i < 9; i++) media(`s${i}.mp4`, 'OK');
    media('voice.mp4', 'OK');
    const e = make({ probe });
    const rel = edit('x.nbcut.json', 'media/voice.mp4', (c) => {
      for (let i = 0; i < 9; i++) c.clips.push({ id: `c${i}`, track: 'v', src: `media/s${i}.mp4`, at: 2 + i, out: 1 });
    });
    await e.start(rel, 'mp4');
    expect(most).toBe(4);
    await until(() => e.job(rel)?.phase !== 'running');
    const g = spawns().at(-1)!.argv;
    const graph = g[g.indexOf('-filter_complex') + 1]!;
    // voice.mp4 is the first input: its sound is mixed, it is not drawn
    expect(graph).toContain('[0:a]');
    expect(graph).not.toContain('[0:v]');
    expect(graph).toContain('[1:v]');
  });

  it('dispose never throws: the temp file goes after the child has exited, a failed removal is only logged', async () => {
    media('a.mp4', 'HANG');
    const removed: { file: string; alive: boolean }[] = [];
    let pid = 0;
    const warn = vi.fn();
    const e = make({
      rm: (file: string) => {
        removed.push({ file, alive: alive(pid) });
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      },
      warn,
    });
    await e.start(edit('x.nbcut.json'), 'mp4');
    await until(() => spawns().length > 0 && fs.readdirSync(path.join(root, 'exports')).length > 0);
    pid = spawns().at(-1)!.pid;
    expect(() => e.dispose()).not.toThrow();
    expect(removed).toEqual([]);
    await until(() => removed.length === 1);
    expect(removed[0]!.alive).toBe(false);
    expect(removed[0]!.file).toMatch(/\.part$/);
    await until(() => warn.mock.calls.length === 1);
    expect(e.job('x.nbcut.json')?.phase).toBe('cancelled');
  });

  it('dispose clears the pending kill timer; all exports share one process exit handler', async () => {
    media('a.mp4', 'HANG');
    const exits = process.listenerCount('exit');
    const e = make({ graceMs: 60_000 });
    const f = make({ graceMs: 60_000 });
    await e.start(edit('x.nbcut.json'), 'mp4');
    await e.start(edit('y.nbcut.json'), 'mp4');
    await f.start(edit('z.nbcut.json'), 'mp4');
    expect(process.listenerCount('exit')).toBeLessThanOrEqual(exits + 1);
    await until(() => spawns().filter((s) => s.argv.at(-1)!.includes('.z.mp4.')).length > 0);
    const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
    const before = timers();
    e.cancel('x.nbcut.json');
    expect(timers()).toBe(before + 1);
    e.dispose();
    expect(timers()).toBe(before);
    f.dispose();
    await until(() => e.job('y.nbcut.json')?.phase === 'cancelled' && f.job('z.nbcut.json')?.phase === 'cancelled');
    expect(process.listenerCount('exit')).toBe(exits);
  });

  it('the first export of a project sweeps its stale temp files (an hour old, of our own pattern only)', async () => {
    const ex = path.join(root, 'exports');
    fs.mkdirSync(ex);
    const old = new Date(Date.now() - 2 * 3600_000);
    const files = ['.x.mp4.0123abcd.part', '.y.wav.89abcdef.part', '.fresh.mp4.00000000.part', '.notes.part', 'x.mp4.0123abcd.part', 'keep.mp4'];
    for (const f of files) {
      fs.writeFileSync(path.join(ex, f), 'old');
      if (f !== '.fresh.mp4.00000000.part') fs.utimesSync(path.join(ex, f), old, old);
    }
    const e = make();
    await e.start(edit('x.nbcut.json'), 'mp4');
    await until(() => e.job('x.nbcut.json')?.phase === 'done');
    await until(() => !fs.existsSync(path.join(ex, '.y.wav.89abcdef.part')));
    expect(fs.readdirSync(ex).sort()).toEqual(['.fresh.mp4.00000000.part', '.notes.part', 'keep.mp4', 'x.mp4', 'x.mp4.0123abcd.part']);
  });

  it('an ffmpeg older than 4.4 is unusable, with its version; a newer one or an unknown build is usable', async () => {
    let v: string | null = '4.3.2';
    const e = make({ version: () => v });
    expect(e.ffmpegState()).toEqual({ ok: false, reason: 'old-ffmpeg', version: '4.3.2' });
    expect(e.available()).toBe(false);
    expect(await refusal(e.start(edit('x.nbcut.json'), 'mp4'))).toMatchObject({ status: 501, code: 'old-ffmpeg', detail: '4.3.2' });
    v = '4.4';
    expect(make({ version: () => v }).ffmpegState()).toEqual({ ok: true });
    expect(make({ version: () => null }).available()).toBe(true);
    expect(make({ ffmpeg: () => null }).ffmpegState()).toEqual({ ok: false, reason: 'no-ffmpeg' });
  });

  it('no ffmpeg: 501, nothing spawned', async () => {
    const before = spawns().length;
    expect(await refusal(make({ ffmpeg: () => null }).start(edit('x.nbcut.json'), 'mp4'))).toMatchObject({ status: 501, code: 'no-ffmpeg' });
    expect(spawns().length).toBe(before);
  });

  describe('path safety: nothing outside the project is read or written', () => {
    it('an edit outside the project, or not an edit, is refused', async () => {
      const e = make();
      fs.writeFileSync(path.join(dir, 'out.nbcut.json'), '{}');
      expect(await refusal(e.start('../out.nbcut.json', 'mp4'))).toMatchObject({ status: 403, code: 'outside-project' });
      expect(await refusal(e.start(path.join(dir, 'out.nbcut.json'), 'mp4'))).toMatchObject({ status: 403 });
      expect(await refusal(e.start('media/a.mp4', 'mp4'))).toMatchObject({ status: 400, code: 'not-an-edit' });
      expect(await refusal(e.start('none.nbcut.json', 'mp4'))).toMatchObject({ status: 404 });
    });

    it('a source outside the project, also through a symlink, is refused before ffmpeg runs', async () => {
      const e = make();
      const before = spawns().length;
      fs.writeFileSync(path.join(dir, 'secret.mp4'), 'OK');
      // a `..` or absolute src is already an invalid edit; a symlink out is caught where the source resolves
      expect(await refusal(e.start(edit('x.nbcut.json', '../secret.mp4'), 'mp4'))).toMatchObject({ status: 422, code: 'invalid-edit' });
      expect(await refusal(e.start(edit('x.nbcut.json', path.join(dir, 'secret.mp4')), 'mp4'))).toMatchObject({ status: 422, code: 'invalid-edit' });
      fs.symlinkSync(path.join(dir, 'secret.mp4'), path.join(root, 'media', 'link.mp4'));
      expect(await refusal(e.start(edit('x.nbcut.json', 'media/link.mp4'), 'mp4'))).toMatchObject({ status: 403, detail: 'media/link.mp4' });
      expect(await refusal(e.start(edit('x.nbcut.json', 'media/gone.mp4'), 'mp4'))).toMatchObject({ status: 422, code: 'missing-source', detail: 'media/gone.mp4' });
      expect(spawns().length).toBe(before);
    });

    it('an exports folder or output that leads outside the project is refused', async () => {
      const e = make();
      const away = path.join(dir, `away${n}`);
      fs.mkdirSync(away);
      fs.symlinkSync(away, path.join(root, 'exports'));
      expect(await refusal(e.start(edit('x.nbcut.json'), 'mp4'))).toMatchObject({ status: 403, code: 'outside-project', detail: 'exports/x.mp4' });
      fs.unlinkSync(path.join(root, 'exports'));
      fs.mkdirSync(path.join(root, 'exports'));
      fs.symlinkSync(path.join(away, 'x.mp4'), path.join(root, 'exports', 'x.mp4'));
      expect(await refusal(e.start(edit('x.nbcut.json'), 'mp4'))).toMatchObject({ status: 403, code: 'outside-project' });
      expect(fs.readdirSync(away)).toEqual([]);
    });
  });

  it('an edit that is no JSON, or has nothing in it, is refused', async () => {
    const e = make();
    fs.writeFileSync(path.join(root, 'bad.nbcut.json'), '{');
    expect(await refusal(e.start('bad.nbcut.json', 'mp4'))).toMatchObject({ status: 422, code: 'bad-edit' });
    expect(await refusal(e.start(edit('empty.nbcut.json', 'media/a.mp4', (c) => { c.clips = []; }), 'mp4'))).toMatchObject({ status: 422, code: 'empty' });
  });

  it('an edit that fails validation is refused with invalid-edit and its issues, before ffmpeg runs', async () => {
    const e = make();
    const before = spawns().length;
    const rel = edit('broken.nbcut.json', 'media/a.mp4', (c) => { c.clips[0]!.in = 3; c.clips.push({ id: 'p', track: 'nope', src: 'media/a.mp4', at: 0, out: 1 }); });
    const r = await refusal(e.start(rel, 'mp4'));
    expect(r).toMatchObject({ status: 422, code: 'invalid-edit' });
    expect(r.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'clips[0].out', code: 'out-before-in', clip: 'c' }),
      expect.objectContaining({ path: 'clips[1].track', code: 'unknown-track', clip: 'p' }),
    ]));
    expect(r.detail).toContain('out-before-in');
    expect(spawns().length).toBe(before);
    expect(e.job(rel)).toBeNull();
  });
});

// a real export: tiny inputs made with ffmpeg's lavfi sources, the output checked with ffprobe
const real = findFfmpeg();
const ffprobe = real && path.join(path.dirname(real), path.basename(real).replace('ffmpeg', 'ffprobe'));
describe.skipIf(!real || !fs.existsSync(ffprobe ?? ''))('a real export through ffmpeg', () => {
  const ff = (...args: string[]) => execFileSync(real!, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const probeJson = (file: string) => JSON.parse(execFileSync(ffprobe!, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' })) as {
    format: { duration: string }; streams: { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; avg_frame_rate?: string; channels?: number }[];
  };

  it('two video tracks (a photo in a place over a trimmed video) and a music track: mp4 and wav of the edit length', async () => {
    const m = path.join(root, 'media');
    ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(m, 'cam.mp4'));
    ff('-f', 'lavfi', '-i', 'testsrc2=size=200x200:duration=1', '-frames:v', '1', path.join(m, 'logo.png'));
    ff('-f', 'lavfi', '-i', 'sine=frequency=660:duration=5', path.join(m, 'music.wav'));
    const c: Cut = {
      version: 1, width: 320, height: 180, fps: 24,
      tracks: [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'a1', kind: 'audio', gain: -6 }],
      clips: [
        { id: 'c1', track: 'v1', src: 'media/cam.mp4', at: 0.5, in: 1, out: 3, gain: -3, fadeIn: 0.2 },
        { id: 'c2', track: 'v2', src: 'media/logo.png', at: 1, dur: 1, place: { x: 0.6, y: 0.1, w: 0.3, h: 0.4, opacity: 0.7 } },
        { id: 'c3', track: 'a1', src: 'media/music.wav', at: 0, in: 0.5, out: 3, fadeOut: 0.5 },
      ],
    };
    fs.writeFileSync(path.join(root, 'demo.nbcut.json'), JSON.stringify(c));
    const e = make({ ffmpeg: () => real, probe: undefined });
    await e.start('demo.nbcut.json', 'mp4');
    await until(() => e.job('demo.nbcut.json')?.phase !== 'running', 60_000);
    expect(e.job('demo.nbcut.json')).toMatchObject({ phase: 'done', progress: 1 });
    const mp4 = probeJson(path.join(root, 'exports', 'demo.mp4'));
    expect(Number(mp4.format.duration)).toBeCloseTo(2.5, 1);
    const v = mp4.streams.find((s) => s.codec_type === 'video')!;
    expect(v).toMatchObject({ codec_name: 'h264', width: 320, height: 180, pix_fmt: 'yuv420p', avg_frame_rate: '24/1' });
    expect(mp4.streams.find((s) => s.codec_type === 'audio')).toMatchObject({ codec_name: 'aac', channels: 2 });

    await e.start('demo.nbcut.json', 'wav');
    await until(() => e.job('demo.nbcut.json')?.phase !== 'running', 60_000);
    expect(e.job('demo.nbcut.json')).toMatchObject({ phase: 'done', output: 'exports/demo.wav' } satisfies Partial<ExportJob>);
    const wav = probeJson(path.join(root, 'exports', 'demo.wav'));
    expect(Number(wav.format.duration)).toBeCloseTo(2.5, 1);
    expect(wav.streams.map((s) => s.codec_type)).toEqual(['audio']);
  }, 60_000);
  /** The picture at `t` s of `file` as rgb24 bytes, `w` x `h`. */
  const frame = (file: string, t: number) => execFileSync(real!, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  const rgb = (f: Buffer, w: number, x: number, y: number) => [...f.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];
  const brightest = (f: Buffer) => f.reduce((a, b) => Math.max(a, b), 0);
  const isRed = ([r, g, b]: number[]) => r! > 180 && g! < 80 && b! < 80;
  const isBlue = ([r, g, b]: number[]) => b! > 180 && r! < 80 && g! < 80;
  /** The loudest sample of `file` between `from` and `from + dur` s, in dB (pure silence is about -91). */
  const loudest = (file: string, from: number, dur: number) => {
    const r = spawnSync(real!, ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(dur), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr);
    if (!m) throw new Error(r.stderr);
    return m[1] === '-inf' ? -Infinity : Number(m[1]);
  };

  it('renders what the edit says: black gaps, the photo in its place while it is shown, sound only from audible clips', async () => {
    const m = path.join(root, 'media');
    ff('-f', 'lavfi', '-i', 'color=c=blue:size=320x240:rate=10:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(m, 'blue.mp4'));
    ff('-f', 'lavfi', '-i', 'color=c=red:size=200x200', '-frames:v', '1', path.join(m, 'red.png'));
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', path.join(m, 'tone.wav'));
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', path.join(m, 'tone.mp4'));
    ff('-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', path.join(m, 'loud.wav'));
    const c: Cut = {
      version: 1, width: 320, height: 180, fps: 10,
      tracks: [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'a1', kind: 'audio' }, { id: 'a2', kind: 'audio', mute: true }],
      clips: [
        { id: 'b', track: 'v1', src: 'media/blue.mp4', at: 0.5, out: 2 },
        // the photo's box is x 160-320, y 0-90; the square image fits it as 90 x 90 at x 195-285
        { id: 'r', track: 'v2', src: 'media/red.png', at: 1, dur: 1, place: { x: 0.5, y: 0, w: 0.5, h: 0.5 } },
        // a video file with no picture stream on a video track: heard, not drawn
        { id: 't', track: 'v1', src: 'media/tone.mp4', at: 2.5, out: 0.5 },
        { id: 's', track: 'a1', src: 'media/tone.wav', at: 1, out: 1 },
        { id: 'm', track: 'a2', src: 'media/loud.wav', at: 0, out: 1 },
      ],
    };
    fs.writeFileSync(path.join(root, 'look.nbcut.json'), JSON.stringify(c));
    const e = make({ ffmpeg: () => real, probe: undefined, version: undefined });
    await e.start('look.nbcut.json', 'mp4');
    await until(() => e.job('look.nbcut.json')?.phase !== 'running', 60_000);
    expect(e.job('look.nbcut.json')).toMatchObject({ phase: 'done' });
    const out = path.join(root, 'exports', 'look.mp4');
    expect(Number(probeJson(out).format.duration)).toBeCloseTo(3, 1);

    const gap = frame(out, 0.25);
    expect(gap.length).toBe(320 * 180 * 3);
    expect(brightest(gap)).toBeLessThan(30);
    const before = frame(out, 0.75);
    expect(isBlue(rgb(before, 320, 240, 45))).toBe(true);
    const shown = frame(out, 1.5);
    expect(isRed(rgb(shown, 320, 240, 45))).toBe(true);
    expect(isBlue(rgb(shown, 320, 170, 45))).toBe(true); // in the box, beside the image
    expect(isBlue(rgb(shown, 320, 80, 135))).toBe(true);
    expect(isBlue(rgb(frame(out, 2.2), 320, 240, 45))).toBe(true);
    // the picture-less video file is not drawn: black after the blue clip
    expect(brightest(frame(out, 2.75))).toBeLessThan(30);

    // the muted track is silent; the voice and the sound on the video track are heard
    expect(loudest(out, 0, 0.9)).toBeLessThan(-60);
    expect(loudest(out, 1.1, 0.8)).toBeGreaterThan(-40);
    expect(loudest(out, 2.6, 0.3)).toBeGreaterThan(-40);
  }, 60_000);

  it('stills in webp and avif are held for their length', async () => {
    const m = path.join(root, 'media');
    const stills: string[] = [];
    ff('-f', 'lavfi', '-i', 'color=c=red:size=64x64', '-frames:v', '1', path.join(m, 'red.png'));
    try {
      ff('-f', 'lavfi', '-i', 'color=c=red:size=64x64', '-frames:v', '1', path.join(m, 'red.avif'));
      stills.push('media/red.avif');
    } catch { /* this ffmpeg cannot encode AVIF */ }
    if (spawnSync('cwebp', ['-quiet', path.join(m, 'red.png'), '-o', path.join(m, 'red.webp')]).status === 0) stills.push('media/red.webp');
    else {
      try {
        ff('-i', path.join(m, 'red.png'), path.join(m, 'red.webp'));
        stills.push('media/red.webp');
      } catch { /* nor WebP */ }
    }
    const e = make({ ffmpeg: () => real, probe: undefined, version: undefined });
    for (const src of stills) {
      const name = `still-${path.extname(src).slice(1)}`;
      fs.writeFileSync(path.join(root, `${name}.nbcut.json`), JSON.stringify({
        version: 1, width: 64, height: 64, fps: 10, tracks: [{ id: 'v', kind: 'video' }],
        clips: [{ id: 'p', track: 'v', src, at: 0.5, dur: 1 }, { id: 'q', track: 'v', src: 'media/red.png', at: 2, dur: 0.5 }],
      } satisfies Cut));
      await e.start(`${name}.nbcut.json`, 'mp4');
      await until(() => e.job(`${name}.nbcut.json`)?.phase !== 'running', 60_000);
      expect(e.job(`${name}.nbcut.json`), src).toMatchObject({ phase: 'done' });
      const out = path.join(root, 'exports', `${name}.mp4`);
      expect(isRed(rgb(frame(out, 0.6), 64, 32, 32)), src).toBe(true);
      expect(isRed(rgb(frame(out, 1.4), 64, 32, 32)), src).toBe(true);
      // held for its dur only: black again after 1.5 s
      expect(brightest(frame(out, 1.75)), src).toBeLessThan(30);
    }
  }, 60_000);
});
