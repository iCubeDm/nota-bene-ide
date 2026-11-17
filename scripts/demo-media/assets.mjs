// The demo project's image and video, drawn here from HTML (original, simple): a landing-page design mock and a short
// screen-recording-style animation of the same page. Rendered with the same Chrome Playwright drives.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CSS = `
* { box-sizing: border-box; margin: 0; }
body { width: var(--w); height: var(--h); overflow: hidden; background: #f4f5fa; color: #1f2430;
  font: 16px/1.5 -apple-system, "SF Pro Text", system-ui, "Helvetica Neue", sans-serif; }
nav { height: 64px; display: flex; align-items: center; padding: 0 56px; gap: 32px; background: #fff; border-bottom: 1px solid #e4e6ee; }
.logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 20px; letter-spacing: -.01em; }
.logo i { width: 26px; height: 26px; border-radius: 8px; background: linear-gradient(135deg, #6d63f5, #4338ca); display: block; position: relative; }
.logo i::after { content: ""; position: absolute; left: 7px; top: 12px; width: 12px; height: 3px; border-radius: 2px; background: #fff; }
nav a { color: #5a6072; text-decoration: none; font-size: 15px; }
nav .sp { flex: 1; }
nav .signin { color: #4338ca; font-weight: 600; }
main { padding: 56px 56px 0; text-align: center; }
h1 { font-size: 46px; line-height: 1.12; letter-spacing: -.025em; }
.sub { margin-top: 12px; color: #5a6072; font-size: 18px; }
.form { margin: 40px auto 0; width: 760px; display: flex; gap: 12px; padding: 10px; background: #fff; border: 1px solid #dfe2ec;
  border-radius: 14px; box-shadow: 0 10px 30px rgba(40,44,90,.08); align-items: center; }
.field { flex: 1; text-align: left; padding: 0 14px; height: 48px; display: flex; align-items: center; color: #9aa0b4; font-size: 17px; white-space: nowrap; overflow: hidden; }
.field.typed { color: #1f2430; }
.caret { display: inline-block; width: 2px; height: 22px; background: #4338ca; margin-left: 1px; vertical-align: middle; }
.cta { height: 36px; padding: 0 16px; border: 1px solid #c9ccd6; border-radius: 6px; background: #fff; color: #3b4054; font-size: 13px; font-weight: 600; font-family: inherit; }
.result { margin: 28px auto 0; width: 760px; background: #fff; border: 1px solid #dfe2ec; border-radius: 14px; padding: 18px 24px; display: flex; align-items: center; gap: 16px; text-align: left; }
.result .code { font-size: 22px; font-weight: 700; color: #4338ca; letter-spacing: -.01em; }
.result .orig { color: #8a90a4; font-size: 14px; margin-top: 2px; }
.result .sp { flex: 1; }
.pill { background: #eceeff; color: #4338ca; border-radius: 999px; padding: 6px 14px; font-size: 14px; font-weight: 600; }
.chips { margin: 36px auto 0; width: 760px; display: flex; gap: 16px; }
.chip { flex: 1; background: #fff; border: 1px solid #e4e6ee; border-radius: 12px; padding: 16px 18px; text-align: left; }
.chip b { display: block; font-size: 15px; margin-bottom: 2px; }
.chip span { color: #6b7185; font-size: 14px; }
`;

const page = (w, h, body, extra = '') => `<!doctype html><meta charset=utf-8><style>:root{--w:${w}px;--h:${h}px}${CSS}${extra}</style>${body}`;

const NAV = `<nav><div class="logo"><i></i>shortly</div><a>Docs</a><a>Pricing</a><a>API</a><span class="sp"></span><a class="signin">Sign in</a></nav>`;

export function landingHtml() {
  return page(800, 540, `${NAV}<main style="padding-top:36px">
    <h1 style="font-size:34px">Short links,<br>made simple.</h1>
    <p class="sub" style="font-size:16px;margin-top:8px">Paste a long address, get a short one you can say out loud.</p>
    <div class="form" style="width:660px;margin-top:28px"><div class="field">Paste a long URL here…</div><button class="cta">Shorten</button></div>
    <div class="result" style="width:660px"><div><div class="code">shortly.example/k7m2xq</div><div class="orig">example.com/blog/2026/how-we-ship-small-changes</div></div><span class="sp"></span><span class="pill">0 clicks</span></div>
    </main>`);
}

const URL_TEXT = 'https://example.com/blog/2026/how-we-ship-small-changes';

/** One frame of the flow at time t seconds (6 s): type the URL, press Shorten, the result appears at once. */
export function flowHtml() {
  return page(800, 500, `${NAV}<main style="padding-top:32px">
    <h1 style="font-size:34px">Short links,<br>made simple.</h1>
    <div class="form" style="width:660px;margin-top:26px"><div class="field" id="f"></div><button class="cta" id="b">Shorten</button></div>
    <div class="result" id="r" style="width:660px;visibility:hidden"><div><div class="code">shortly.example/k7m2xq</div><div class="orig">example.com/blog/2026/how-we-ship-small-changes</div></div><span class="sp"></span><span class="pill">0 clicks</span></div>
    </main>
    <script>
      const URL_TEXT = ${JSON.stringify(URL_TEXT)};
      window.render = (t) => {
        const f = document.getElementById('f'), b = document.getElementById('b'), r = document.getElementById('r');
        const n = Math.max(0, Math.min(URL_TEXT.length, Math.floor((t - 0.3) * 40)));
        f.className = 'field' + (n ? ' typed' : '');
        f.innerHTML = n ? URL_TEXT.slice(0, n) + (t < 1.9 && Math.floor(t * 2) % 2 === 0 ? '<span class="caret"></span>' : '') : '<span style="color:#9aa0b4">Paste a long URL here…</span>';
        const pressed = t >= 2.0 && t < 2.2;
        b.style.background = pressed ? '#e6e8f2' : t >= 2.2 && t < 2.5 ? '#f3f4f9' : '#fff';
        b.textContent = t >= 2.2 && t < 2.5 ? 'Shortening…' : 'Shorten';
        r.style.visibility = t >= 2.5 ? 'visible' : 'hidden';
      };
    </script>`);
}

/** Writes design/landing.png and media/flow.mp4 into `dir` (a project root). Needs a Playwright `chromium` and ffmpeg. */
export async function makeAssets(chromium, dir) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    fs.mkdirSync(path.join(dir, 'design'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
    const img = await browser.newPage({ viewport: { width: 800, height: 540 }, deviceScaleFactor: 1 });
    await img.setContent(landingHtml());
    await img.screenshot({ path: path.join(dir, 'design/landing.png') });
    await img.close();

    const fps = 20, secs = 6;
    const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-flow-'));
    const vp = await browser.newPage({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 1 });
    await vp.setContent(flowHtml());
    for (let i = 0; i < fps * secs; i++) {
      await vp.evaluate((t) => window.render(t), i / fps);
      await vp.screenshot({ path: path.join(frames, `f${String(i).padStart(4, '0')}.png`) });
    }
    await vp.close();
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(fps), '-i', path.join(frames, 'f%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', path.join(dir, 'media/flow.mp4')]);
    fs.rmSync(frames, { recursive: true, force: true });
  } finally {
    await browser.close();
  }
}

// ---- the video edit's sources: a title card, a logo badge, a voice-over and a music bed ---------------------------------

function titleHtml() {
  return `<!doctype html><meta charset=utf-8><style>${CSS}
    body { --w: 800px; --h: 500px; background: radial-gradient(120% 90% at 30% 20%, #4f46e5 0%, #312e81 55%, #1e1b4b 100%); color: #fff;
      display: grid; place-items: center; text-align: center; }
    .t { font-size: 64px; font-weight: 800; letter-spacing: -.03em; display: flex; align-items: center; gap: 18px; justify-content: center; }
    .t i { width: 58px; height: 58px; border-radius: 16px; background: #fff; display: block; position: relative; }
    .t i::after { content: ""; position: absolute; left: 15px; top: 26px; width: 28px; height: 7px; border-radius: 4px; background: #4338ca; }
    .s { margin-top: 14px; font-size: 24px; opacity: .85; }
  </style><div><div class="t" id="t"><i></i>shortly</div><div class="s" id="s">Short links, made simple.</div></div>
  <script>
    window.render = (t) => {
      const e = (x) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
      const a = e(t / 0.8), b = e((t - 0.5) / 0.8);
      document.getElementById('t').style.cssText = 'opacity:' + a + ';transform:translateY(' + (1 - a) * 24 + 'px) scale(' + (0.96 + 0.04 * a) + ')';
      document.getElementById('s').style.cssText = 'opacity:' + b * 0.85 + ';transform:translateY(' + (1 - b) * 16 + 'px)';
    };
  </script>`;
}

function badgeHtml() {
  return `<!doctype html><meta charset=utf-8><style>${CSS}
    html, body { --w: 480px; --h: 160px; background: transparent; }
    .b { margin: 10px; height: 140px; border-radius: 28px; background: #fff; display: flex; align-items: center; justify-content: center; gap: 22px;
      font-size: 58px; font-weight: 800; letter-spacing: -.03em; color: #1f2430; box-shadow: 0 4px 12px rgba(0,0,0,.25); }
    .b i { width: 64px; height: 64px; border-radius: 18px; background: linear-gradient(135deg, #6d63f5, #4338ca); display: block; position: relative; }
    .b i::after { content: ""; position: absolute; left: 17px; top: 29px; width: 30px; height: 7px; border-radius: 4px; background: #fff; }
  </style><div class="b"><i></i>shortly</div>`;
}

/** Synthetic speech (macOS `say`) as a mono WAV, `lead` seconds of silence first. False where there is no `say`. */
export function speak(text, out, { rate = 44100, lead = 0, volume = 1 } = {}) {
  const aiff = `${out}.aiff`;
  try {
    execFileSync('say', ['-r', '175', '-o', aiff, text]);
  } catch {
    return false;
  }
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', aiff, '-af', `adelay=${Math.round(lead * 1000)}:all=1,apad=pad_dur=0.3,volume=${volume}`, '-ac', '1', '-ar', String(rate), '-c:a', 'pcm_s16le', out]);
  fs.rmSync(aiff, { force: true });
  return true;
}

/** A short music bed, generated: a plucked arpeggio over a soft bass and a kick on every beat (120 bpm). */
function music(out, secs) {
  const step = 'mod(floor(4*t),8)';
  const f = `220*if(eq(${step},0),1,if(eq(${step},1),1.2599,if(eq(${step},2),1.4983,if(eq(${step},3),2,if(eq(${step},4),1.4983,if(eq(${step},5),1.2599,if(eq(${step},6),1.3348,1.1225)))))))`;
  const expr = `0.28*sin(2*PI*${f}*t)*exp(-6*mod(t,0.25))+0.10*sin(2*PI*110*t)+0.45*sin(2*PI*(50+90*exp(-30*mod(t,0.5)))*t)*exp(-12*mod(t,0.5))`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=${secs}`, '-af', 'volume=0.35', '-ac', '1', '-c:a', 'pcm_s16le', out]);
}

export const VOICE_OVER = 'Paste a long link and press Shorten. Your short link is ready to share.';

/** Writes media/title.mp4, media/logo.png, media/voice-over.wav and media/music.wav into `dir` (the edit's sources). */
export async function makeEditAssets(chromium, dir) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const badge = await browser.newPage({ viewport: { width: 480, height: 160 }, deviceScaleFactor: 1 });
    await badge.setContent(badgeHtml());
    await badge.screenshot({ path: path.join(dir, 'media/logo.png'), omitBackground: true });
    await badge.close();
    const fps = 20, secs = 3;
    const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-title-'));
    const vp = await browser.newPage({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 1 });
    await vp.setContent(titleHtml());
    for (let i = 0; i < fps * secs; i++) {
      await vp.evaluate((t) => window.render(t), i / fps);
      await vp.screenshot({ path: path.join(frames, `f${String(i).padStart(4, '0')}.png`) });
    }
    await vp.close();
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(fps), '-i', path.join(frames, 'f%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', path.join(dir, 'media/title.mp4')]);
    fs.rmSync(frames, { recursive: true, force: true });
  } finally {
    await browser.close();
  }
  const vo = path.join(dir, 'media/voice-over.wav');
  if (speak(VOICE_OVER, `${vo}.raw.wav`, { volume: 0.5 })) {
    // padded to whole seconds: the clip's numbers in the editor's panel stay whole (a number field shows the system's
    // decimal separator, whatever the page's language)
    const len = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `${vo}.raw.wav`], { encoding: 'utf8' }));
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${vo}.raw.wav`, '-af', `apad=whole_dur=${Math.ceil(len)}`, '-c:a', 'pcm_s16le', vo]);
    fs.rmSync(`${vo}.raw.wav`, { force: true });
  } else {
    // no speech synthesis here: a tone with a speech-like rhythm keeps the timeline's shape
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*180*t)*abs(sin(2*PI*1.7*t))':s=44100:d=5", '-c:a', 'pcm_s16le', vo]);
  }
  music(path.join(dir, 'media/music.wav'), 10);
}
