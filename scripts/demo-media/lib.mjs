import { createHmac, randomBytes } from "node:crypto";
// Shared helpers: the demo server, a fake cursor, pacing, and the video -> GIF conversion.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUT_PATH, TEXT, cutDoc, fakeScript, writeProject } from './project.mjs';
import { makeAssets, makeEditAssets, speak } from './assets.mjs';

export const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const PORT = 4790;
export const URL_BASE = `http://127.0.0.1:${PORT}`;
// the login a window opened by the launcher would get: the fragment carries it, POST /auth accepts it
const TOKEN = randomBytes(32).toString("hex");
const NONCE = randomBytes(16).toString("hex");
export const LOGIN_URL = `${URL_BASE}/#t=${createHmac("sha256", TOKEN).update(`nota-bene:login:${PORT}:${NONCE}`).digest("hex")}`;
/** A neutral path with no user name in it: it is what the window shows as the project. Removed again at the end of a run. */
export const PROJECT = '/Users/Shared/demo-project';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Removes the demo project and its siblings. */
export function cleanup() {
  for (const dir of [PROJECT, ...SIBLINGS.map((s) => s.root)]) fs.rmSync(dir, { recursive: true, force: true });
}

/** Creates the demo project and its siblings (fresh each time) and a temp state dir; returns both. Assets are generated once per run. */
export async function prepare(chromium, work) {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  writeProject(PROJECT);
  for (const s of SIBLINGS) {
    fs.rmSync(s.root, { recursive: true, force: true });
    fs.mkdirSync(s.root, { recursive: true });
    fs.writeFileSync(path.join(s.root, 'README.md'), s.readme);
  }
  await makeAssets(chromium, PROJECT);
  await makeEditAssets(chromium, PROJECT);
  const voiceLen = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(PROJECT, 'media/voice-over.wav')], { encoding: 'utf8' }));
  fs.writeFileSync(path.join(PROJECT, CUT_PATH), JSON.stringify(cutDoc(voiceLen), null, 2) + '\n');
  // the voice message the fake microphone plays (Chrome's fake capture), and the same words at 16 kHz to load Whisper first
  const voice = path.join(work, 'voice.wav');
  const voice16 = path.join(work, 'voice16.wav');
  const spoken = speak(TEXT.voice, voice, { rate: 48000, lead: 0.5 }) && speak(TEXT.voice, voice16, { rate: 16000 });
  const script = path.join(work, 'fake.json');
  fs.writeFileSync(script, JSON.stringify(fakeScript()));
  return { script, voice: spoken ? voice : null, voice16: spoken ? voice16 : null };
}

/** Folders of other demo projects, open in windows of their own beside the demo one: they fill the projects rail. */
export const SIBLINGS = [
  { root: '/Users/Shared/docs-site', port: PORT + 1, readme: '# docs-site\n\nThe user guide of shortly, built with a static site generator.\n' },
  { root: '/Users/Shared/mobile-app', port: PORT + 2, readme: '# mobile-app\n\nA small companion app for shortly: paste a link, share the short one.\n' },
];

/** Strips everything a launcher this script may run under passes on (a Nota Bene window's terminal): demo servers are unsupervised. */
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NOTA_BENE_')));

/**
 * Starts a server on 4790 (waits while another agent holds the port) with a fresh state dir, and the sibling projects'
 * servers on the next ports, registered as windows so the rail shows them. `whisper`: a Whisper install to clone into the
 * state dir (voice messages), with Whisper turned on; its host lives in this temp state dir and idles out soon after.
 * Returns { stop(), home }.
 */
export async function startServer(work, script, name, { codex, whisper } = {}) {
  fs.rmSync(path.join(PROJECT, '.nota-bene'), { recursive: true, force: true }); // marks of an earlier scene
  const home = fs.mkdtempSync(path.join(work, `home-${name}-`));
  const vault = fs.mkdtempSync(path.join(work, `vault-${name}-`));
  for (const port of [PORT, ...SIBLINGS.map((s) => s.port)]) {
    for (let attempt = 0; ; attempt++) {
      if (!(await portBusy(port))) break;
      if (attempt > 60) throw new Error(`port ${port} stays busy`);
      console.log(`port ${port} busy, waiting…`);
      await sleep(5000);
    }
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'token'), TOKEN, { mode: 0o600 });
  const state = codex ? path.join(home, 'providers/codex') : home;
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(state, 'token'), TOKEN, { mode: 0o600 });
  if (whisper) {
    try { execFileSync('cp', ['-cR', whisper, path.join(home, 'whisper')]); } catch { fs.cpSync(whisper, path.join(home, 'whisper'), { recursive: true }); }
    fs.writeFileSync(path.join(home, 'prefs.json'), JSON.stringify({ whisper: true, dictationLang: 'en' }));
  }
  const env = { ...cleanEnv(), NOTA_BENE_HOME: home, NOTA_BENE_NONCE: NONCE, CLAUDE_JOURNAL_VAULT: vault, NOTA_BENE_EXPERIMENTAL_3D: '0', NOTA_BENE_TEST_WHISPER_IDLE_MS: '8000' };
  let stopping = false;
  const spawnOne = (root, port, args, extra = {}) => {
    const c = spawn(process.execPath, [path.join(REPO, 'server/src/main.ts'), root, '--port', String(port), ...args], {
      cwd: REPO, env: { ...env, ...extra }, stdio: ['ignore', 'ignore', 'inherit'],
    });
    c.on('exit', (code, sig) => { if (!stopping) console.error(`server on ${port} exited: ${code ?? sig}`); });
    return c;
  };
  const children = [spawnOne(PROJECT, PORT, codex ? ['--agent', 'codex'] : ['--fake', script], codex ? { NOTA_BENE_CODEX: codex } : {})];
  for (const s of SIBLINGS) children.push(spawnOne(s.root, s.port, ['--fake', script]));
  const register = (dir, port, root, pid) => {
    fs.mkdirSync(path.join(dir, 'windows'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'windows', `${port}.json`), JSON.stringify({ root, pid, startedAt: Date.now() }));
  };
  register(state, PORT, PROJECT, children[0].pid);
  SIBLINGS.forEach((s, i) => register(home, s.port, s.root, children[i + 1].pid));
  for (const port of [PORT, ...SIBLINGS.map((s) => s.port)]) {
    for (let i = 0; i < 100; i++) {
      if (await portBusy(port)) break;
      await sleep(100);
    }
  }
  return {
    home,
    async stop() {
      stopping = true;
      await Promise.all(children.map((child) => {
        child.kill('SIGTERM');
        return new Promise((r) => { child.on('exit', r); setTimeout(r, 3000).unref(); });
      }));
      await stopWhisperHost(home);
    },
  };
}

/** Transcribes `wav` (16 kHz mono) once, off camera, so the model is loaded before the scene's voice message. */
export async function warmWhisper(wav) {
  const r = await fetch(`${URL_BASE}/dictation/transcribe?lang=en`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, origin: URL_BASE, 'content-type': 'audio/wav' }, body: fs.readFileSync(wav) });
  return r.ok ? (await r.json()).text : `HTTP ${r.status} ${await r.text()}`;
}

/** Waits for the Whisper host of this temp state dir to idle out; one that does not is stopped by the pid holding its socket. */
async function stopWhisperHost(home) {
  const dir = path.join(home, 'whisper-host');
  const socks = () => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.sock')).map((f) => path.join(dir, f)); } catch { return []; } };
  for (let i = 0; i < 60 && socks().length; i++) await sleep(500);
  for (const sock of socks()) {
    let pids = '';
    try { pids = execFileSync('lsof', ['-t', sock], { encoding: 'utf8' }).trim(); } catch {}
    for (const pid of pids.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid), 'SIGTERM'); } catch {} }
  }
}

async function portBusy(port = PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/info`);
    return r.ok || true;
  } catch {
    return false;
  }
}

/** A visible cursor (an arrow with a click ripple) that follows the real mouse events Playwright dispatches. */
export const CURSOR_INIT = `
(() => {
  const mk = () => {
    if (document.getElementById('demo-cursor')) return;
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))';
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M5 3 L5 22 L10 17.5 L13.6 25 L17 23.4 L13.4 16 L20 16 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const style = document.createElement('style');
    style.textContent = '@keyframes demo-ripple{from{transform:translate(-50%,-50%) scale(.3);opacity:.9}to{transform:translate(-50%,-50%) scale(1.5);opacity:0}}';
    document.documentElement.appendChild(style);
    const move = (e) => { c.style.transform = 'translate(' + (e.clientX - 5) + 'px,' + (e.clientY - 3) + 'px)'; window.__demoPos = [e.clientX, e.clientY]; };
    addEventListener('mousemove', move, true);
    addEventListener('mousedown', (e) => {
      move(e);
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;width:44px;height:44px;border-radius:50%;border:2px solid rgba(120,170,255,.95);background:rgba(120,170,255,.25);left:' + e.clientX + 'px;top:' + e.clientY + 'px;animation:demo-ripple .5s ease-out forwards';
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 600);
    }, true);
  };
  if (document.documentElement) mk(); else addEventListener('DOMContentLoaded', mk);
})();
`;

/** Moves the mouse smoothly (ease in-out) to (x, y) in about `ms`, so the viewer can follow the pointer. */
export async function glide(page, x, y, ms = 700) {
  const from = (await page.evaluate(() => window.__demoPos)) ?? [x, y - 150];
  const t0 = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - t0) / ms);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(from[0] + (x - from[0]) * e, from[1] + (y - from[1]) * e);
    if (t >= 1) break;
  }
}

export async function glideTo(page, locator, ms = 700, where = [0.5, 0.5]) {
  const b = await locator.boundingBox();
  await glide(page, b.x + b.width * where[0], b.y + b.height * where[1], ms);
}

export async function clickAt(page, locator, ms = 700) {
  await glideTo(page, locator, ms);
  await sleep(90);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  await sleep(160);
}

/** Types at a visible speed (ms per character, a little uneven). */
export async function typeSlow(locator, text, ms = 55) {
  for (const ch of text) {
    await locator.pressSequentially(ch);
    await sleep(ms + (ch === ' ' ? 25 : 0));
  }
}

/**
 * Screencast frames ({file, t} in epoch seconds, a frame is held until the next) to a looping GIF: the part between
 * marks.from and marks.to, plus `hold` seconds on the last frame, 1600 px wide (the screencast's frames come at the
 * viewport's CSS size), 12 fps, one palette for the whole clip, a short fade from and to the window's background colour so the loop does not jump. Returns the duration in seconds.
 */
export function framesToGif(frames, marks, gif, dir, { hold = 1.5, width = 1600, fps = 12, bg = '0x0b0e17' } = {}) {
  const inRange = frames.filter((f) => f.t < marks.to);
  let start = 0;
  while (start + 1 < inRange.length && inRange[start + 1].t <= marks.from) start++;
  const used = inRange.slice(start);
  const lines = [];
  used.forEach((f, i) => {
    const next = i + 1 < used.length ? used[i + 1].t : marks.to;
    const d = Math.max(0.001, next - Math.max(f.t, marks.from));
    lines.push(`file '${f.file}'`, `duration ${d.toFixed(4)}`);
  });
  lines.push(`file '${used.at(-1).file}'`, `duration ${hold}`, `file '${used.at(-1).file}'`);
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, lines.join('\n'));
  const dur = marks.to - marks.from + hold;
  const vf = [
    `fps=${fps}`,
    `scale=${width}:-1:flags=lanczos`,
    `fade=t=in:st=0:d=0.3:color=${bg}`,
    `fade=t=out:st=${(dur - 0.35).toFixed(2)}:d=0.35:color=${bg}`,
  ].join(',');
  // two passes: the frames to a lossless 12 fps clip, then the GIF with one palette (palettegen and paletteuse over the
  // concat input directly lose frames in newer ffmpeg, and the GIF then plays too fast)
  const mid = path.join(dir, 'mid.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-t', dur.toFixed(2), '-vf', vf, '-c:v', 'ffv1', mid]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mid, '-filter_complex',
    'split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', '-loop', '0', gif]);
  return dur;
}

export { os };
