// A clip played backwards (issue 492): the preview plays a reversed copy of the clip's used part forwards. ffmpeg makes it
// once (`reverse` for the picture, `areverse` for the sound, both holding the part in memory) into the project's
// `<root>/.nota-bene/reverse/`, kept out of git like the marks and served by /file as any project file. A copy is named
// by a hash of the source's path, size and mtime and the part, so an edited source or another part is a new copy; the
// newest KEEP stay. One copy is made at a time; a waiting part the page stopped asking for (it polls every second while
// it wants one) is dropped when its turn comes, so an edit changed many times in a row makes only what it still has. The
// picture is scaled to fit PREVIEW and made 8-bit yuv420p before it is reversed, and a part over REVERSE_BUDGET is refused.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AUDIO, VIDEO } from '@nota-bene/shared/cut';
import { resolveInRoot } from '../files.ts';
import { fitIn, REVERSE_BUDGET, reverseBytes } from './args.ts';
import { projectDir } from '../marks.ts';
import { HIDDEN } from '../platform.ts';
import { ffmpegEnv, probe } from './ffmpeg.ts';

/** the folder under `.nota-bene`, project-relative as /file takes it */
const DIR = 'reverse';
/** copies kept on disk, the newest by use */
const KEEP = 24;
/** a copy that takes longer is stopped: minutes of footage held in memory and encoded */
const TIMEOUT_MS = 10 * 60_000;
/** a waiting part not asked for again within this is no longer wanted: the page asks every second (web/src/cut/reverse.ts) */
const STALE_MS = 5000;
/** the preview copy's largest picture */
const PREVIEW = { w: 1280, h: 720 };
/** failed copies remembered */
const KEEP_FAILED = 512;

export class ReverseError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export type ReverseOptions = {
  /** read at each ask: the root changes when the session switches to another project */
  root: () => string;
  ffmpeg: () => string | null;
  /** the server's state folder: a project whose `.nota-bene` is it (root = $HOME) gets no copies */
  stateDir?: () => string;
  /** told on each copy started (tests count them) */
  spawned?: () => void;
  timeoutMs?: number;
  /** ms after its last ask a waiting part is dropped; STALE_MS by default */
  staleMs?: number;
  /** copies kept; KEEP by default */
  keep?: number;
};

const num = (n: number): string => String(Math.round(n * 1e6) / 1e6);

export class CutReverse {
  private readonly failed = new Map<string, ReverseError>();
  /** the copies asked for and not done, by key: the one being made and those waiting */
  private readonly running = new Set<string>();
  private readonly waiting: { key: string; asked: number; make: () => Promise<void> }[] = [];
  private busy = false; // one copy at a time: each holds its part in memory
  private readonly live = new Set<ChildProcess>();
  private disposed = false;
  private readonly o: ReverseOptions;
  constructor(o: ReverseOptions) {
    this.o = o;
  }

  /**
   * The project-relative path of the reversed copy of `rel` from `from` to `to` seconds; null while it is being made (the
   * first ask starts it). `soundOnly`: its sound alone (a video on an audio track). Refusals are ReverseError: 400 bad-part
   * or not-media, 403 outside-project, 404 not-found, 501 no-ffmpeg, 422 failed or too-long, 504 timeout, 503 closing; a
   * copy that failed is not tried again until the source changes.
   */
  async get(rel: string, from: number, to: number, soundOnly = false): Promise<string | null> {
    if (this.disposed) throw new ReverseError(503, 'closing');
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) throw new ReverseError(400, 'bad-part');
    const root = this.o.root();
    const abs = resolveInRoot(root, rel);
    if (!abs) throw new ReverseError(403, 'outside-project');
    if (!AUDIO.test(abs) && !VIDEO.test(abs)) throw new ReverseError(400, 'not-media');
    const sound = soundOnly || AUDIO.test(abs);
    const st = await fs.promises.stat(abs).catch(() => null);
    if (!st?.isFile()) throw new ReverseError(404, 'not-found');
    const key = `${abs}\n${st.size}\n${st.mtimeMs}\n${num(from)}\n${num(to)}${sound ? '\nsound' : ''}`;
    const name = `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}${sound ? '.m4a' : '.mp4'}`;
    const out = `.nota-bene/${DIR}/${name}`;
    const failed = this.failed.get(key);
    if (failed) throw failed;
    if (this.running.has(key)) {
      const w = this.waiting.find((j) => j.key === key);
      if (w) w.asked = Date.now();
      return null;
    }
    const file = path.join(root, out);
    if (fs.existsSync(file)) {
      const now = new Date();
      fs.promises.utimes(file, now, now).catch(() => {}); // the newest again
      return out;
    }
    const ffmpeg = this.o.ffmpeg();
    if (!ffmpeg) throw new ReverseError(501, 'no-ffmpeg');
    let dir: string;
    try {
      dir = projectDir(path.resolve(root), DIR, this.o.stateDir);
    } catch {
      throw new ReverseError(403, 'no-folder');
    }
    this.running.add(key);
    this.waiting.push({
      key, asked: Date.now(), make: () => this.make(ffmpeg, abs, sound, from, to, path.join(dir, name)).then(() => this.trim(dir), (e: unknown) => {
        // a failed, too long or too slow copy stays known for its source version; closing or a spawn failure is asked again
        if (e instanceof ReverseError && ['failed', 'too-long', 'timeout'].includes(e.code)) {
          this.failed.set(key, e);
          for (const k of this.failed.keys()) if (this.failed.size > KEEP_FAILED) this.failed.delete(k);
        }
      }),
    });
    this.next();
    return null;
  }

  private next(): void {
    if (this.busy || this.disposed) return;
    let job = this.waiting.shift();
    // a part no longer asked for is dropped (asked again, it waits anew)
    while (job && Date.now() - job.asked > (this.o.staleMs ?? STALE_MS)) {
      this.running.delete(job.key);
      job = this.waiting.shift();
    }
    if (!job) return;
    this.busy = true;
    void job.make().finally(() => {
      this.running.delete(job.key);
      this.busy = false;
      this.next();
    });
  }

  /** Stops the running copy. The server calls it on close: it never throws. */
  dispose(): void {
    this.disposed = true;
    this.waiting.length = 0;
    for (const c of this.live) c.kill('SIGKILL');
  }

  // the newest `keep` copies stay; a copy's leftover part (a server killed mid-copy) goes once it is older than a copy may take
  private trim(dir: string): void {
    const now = Date.now();
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return; // the folder gone (the project moved away): nothing to keep in bounds
    }
    const files = names.flatMap((n) => {
      const st = fs.statSync(path.join(dir, n), { throwIfNoEntry: false });
      return st?.isFile() ? [{ n, t: st.mtimeMs }] : [];
    });
    const copies = files.filter((f) => !f.n.startsWith('.')).sort((a, b) => b.t - a.t);
    const stale = files.filter((f) => f.n.startsWith('.') && now - f.t > (this.o.timeoutMs ?? TIMEOUT_MS) * 2);
    for (const f of [...copies.slice(this.o.keep ?? KEEP), ...stale]) {
      try {
        fs.rmSync(path.join(dir, f.n), { force: true });
      } catch { /* in use (Windows): the next trim takes it */ }
    }
  }

  private async make(ffmpeg: string, abs: string, sound: boolean, from: number, to: number, file: string): Promise<void> {
    if (this.disposed) throw new ReverseError(503, 'closing');
    const has = await probe(ffmpeg, abs);
    const video = has.video && !sound; // a sound file's cover art is no picture
    if (!video && !has.audio) throw new ReverseError(422, 'failed');
    const pic = video ? fitIn(has.width, has.height, Math.min(PREVIEW.w, has.width ?? PREVIEW.w), Math.min(PREVIEW.h, has.height ?? PREVIEW.h)) : { w: 0, h: 0 };
    if (reverseBytes(to - from, pic.w, pic.h, has.fps ?? 30, has.audio) > REVERSE_BUDGET) throw new ReverseError(422, 'too-long');
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.part`);
    // a proxy for the preview, fit into PREVIEW (never larger) before reverse holds its frames: H.264 with a key frame every
    // 10 frames, so a seek decodes little; even sides for yuv420p
    const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...(from > 0 ? ['-ss', num(from)] : []), '-t', num(to - from), '-i', abs,
      '-sn', '-dn',
      ...(video ? ['-map', '0:v:0', '-vf', `scale='min(${PREVIEW.w},iw)':'min(${PREVIEW.h},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p,reverse`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '10'] : ['-vn']),
      ...(has.audio ? ['-map', '0:a:0', '-af', 'areverse', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
      '-movflags', '+faststart', '-f', 'mp4', tmp];
    try {
      await this.run(ffmpeg, args);
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }

  private run(ffmpeg: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(new ReverseError(503, 'closing'));
      let child: ChildProcess;
      try {
        child = spawn(ffmpeg, args, { env: ffmpegEnv(), stdio: 'ignore', shell: false, ...HIDDEN });
      } catch (e) {
        return reject(e);
      }
      this.o.spawned?.();
      this.live.add(child);
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        child.kill('SIGKILL');
      }, this.o.timeoutMs ?? TIMEOUT_MS);
      const done = (code: number | null, e?: Error) => {
        clearTimeout(timer);
        if (!this.live.delete(child)) return;
        if (e) return reject(e);
        if (this.disposed) return reject(new ReverseError(503, 'closing'));
        if (late) return reject(new ReverseError(504, 'timeout'));
        if (code !== 0) return reject(new ReverseError(422, 'failed'));
        resolve();
      };
      child.on('error', (e) => done(null, e));
      child.on('close', (code) => done(code));
    });
  }
}
