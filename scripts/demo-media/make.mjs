// Regenerates the README / user-guide media in docs/media/ (GIFs and PNGs) from the real UI, with no real agent.
//
//   node scripts/demo-media/make.mjs [--only annotate-text,overview,...] [--out docs/media]
//
// Needs: Node >= 23.6, system Chrome (Playwright drives it, nothing is downloaded), ffmpeg and ffprobe on PATH,
// `npm install` done. It runs `npm run build -w web` first when web/dist is missing or older than web/src (that writes
// web/dist of this checkout).
// It starts the server on port 4790 with the fake backend (--fake, scripted replies), a temp state dir and a temp journal
// vault, all in a work dir /tmp/nbdm-* (os.tmpdir() on Windows; short, for a Whisper host's socket path). The demo
// folders go in /Users/Shared/nb-demo, marked with .nb-demo-media when made: demo-project (a tiny URL shortener, with a
// generated image, a screen recording and a video edit of them), and docs-site and mobile-app with servers of their own on
// 4791 and 4792, so the projects rail shows three projects. A run refuses an nb-demo folder without the mark, and removes
// its own and the work dir at the end, also on Ctrl+C (which stops the servers it started). If a port is busy it waits.
// Nothing else outside the work dir, nb-demo, web/dist and the output folder is written.
//
// Scenes: annotate-text.gif (hero), annotate-code.gif, annotate-image.gif (a rectangle and a mask), annotate-video.gif,
// video-editor.gif (an edit with video, a photo, a voice-over and music: gain, playing the preview, a comment, the agent's
// change highlighted; the fake agent writes nothing, so the scene writes the edit for it), voice-message.gif, overview.png,
// slash-menu.png, codex.png (a Codex window on the scripted app-server codex-app-server.mjs).
//
// voice-message needs macOS `say` (the spoken message, played by Chrome's fake microphone) and a Whisper install to copy
// into the scene's temp state dir: DEMO_WHISPER, else ~/.nota-bene/whisper (only read; its running host, if any, is left
// alone: the scene's server starts its own in the temp state dir, which idles out right after). Without them it is skipped.
// The edit's voice-over is `say` too, or a tone without it. DEMO_DEBUG=1 logs the page and leaves screenshots in /tmp/nbx.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { CURSOR_INIT, PROJECT, REPO, URL_BASE, LOGIN_URL, cleanup, stopAll, clickAt, glide, glideTo, prepare, sleep, startServer, framesToGif, typeSlow, warmWhisper } from './lib.mjs';
import { CUT_PATH, TEXT, agentCut } from './project.mjs';
import { flowHtml, landingHtml } from './assets.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const only = opt('--only')?.split(',');
const OUT = path.resolve(REPO, opt('--out') ?? 'docs/media');
fs.mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
// short: a Whisper host's socket under a state dir in here must fit sun_path (about 104 bytes)
const work = fs.mkdtempSync(process.platform === 'win32' ? path.join(os.tmpdir(), 'nbdm-') : '/tmp/nbdm-');

// ---- the page ----------------------------------------------------------------------------------------------------
const composer = (p) => p.getByPlaceholder(/Message the agent/);
const panel = (p) => p.locator('#comments');
const cards = (p) => panel(p).locator('[data-comment-id]');
const commentBox = (p) => p.getByPlaceholder('Comment…');
const addBtn = (p) => p.getByRole('button', { name: /^Add$/ });
const doneLines = (p) => p.locator('[data-kind="done"]');

/** Hides what looks like a test artifact: the (fake) session id in the header. */
const HIDE = '#session { visibility: hidden }';

/** DEMO_DEBUG=1: a screenshot at a step of a scene, in /tmp/nbx. */
if (process.env.DEMO_DEBUG) fs.mkdirSync('/tmp/nbx', { recursive: true });
const snap = (page, tag) => (process.env.DEMO_DEBUG ? page.screenshot({ path: `/tmp/nbx/step-${tag}.png` }) : undefined);

async function openPage(browser, { record = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, locale: 'en-US', colorScheme: 'dark',
  });
  await ctx.addInitScript(CURSOR_INIT);
  await ctx.addInitScript(() => { try { localStorage.setItem('lang', 'en'); } catch {} });
  const page = await ctx.newPage();
  if (process.env.DEMO_DEBUG) {
    page.on('console', (m) => console.log('  [console]', m.type(), m.text().slice(0, 300)));
    page.on('response', async (r) => { if (r.status() >= 400) console.log('  [http]', r.status(), r.request().method(), r.url().slice(0, 80), (await r.text().catch(() => '')).slice(0, 200)); });
    page.on('websocket', (ws) => { console.log('  [ws open]', ws.url().slice(0, 60)); ws.on('close', () => console.log('  [ws close]')); });
  }
  const t0 = Date.now();
  await page.goto(LOGIN_URL);
  await page.addStyleTag({ content: HIDE });
  await composer(page).waitFor();
  return { ctx, page, t0, since: () => (Date.now() - t0) / 1000 };
}

/** Sends a message quickly (setup, not for the viewer) and waits until the turn is done. */
async function ask(page, text) {
  const n = await doneLines(page).count();
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await page.waitForFunction((k) => document.querySelectorAll('[data-kind="done"]').length > k, n, { timeout: 60000 });
}

async function waitDone(page, n) {
  await page.waitForFunction((k) => document.querySelectorAll('[data-kind="done"]').length >= k, n, { timeout: 60000 });
  await sleep(300);
}

/** The client rects (one per line) of `phrase` inside the element matching `rootSel`; the phrase may span several text nodes. */
async function phraseRects(page, rootSel, phrase, nth = 0) {
  return page.evaluate(([sel, ph, k]) => {
    const list = document.querySelectorAll(sel);
    const root = list[k < 0 ? list.length + k : k];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = []; let full = '';
    for (let n; (n = w.nextNode());) { nodes.push([n, full.length]); full += n.data; }
    const i = full.indexOf(ph);
    if (i < 0) throw new Error(`phrase not found: ${ph}`);
    const at = (pos) => { for (let j = nodes.length - 1; j >= 0; j--) if (nodes[j][1] <= pos) return [nodes[j][0], pos - nodes[j][1]]; };
    const [a, ao] = at(i); const [b, bo] = at(i + ph.length - 1);
    const r = document.createRange(); r.setStart(a, ao); r.setEnd(b, bo + 1);
    root.scrollIntoView({ block: 'nearest' });
    return [...r.getClientRects()].map((x) => [x.x, x.y, x.width, x.height]);
  }, [rootSel, phrase, nth]);
}

/** Selects `phrase` with a real mouse drag, at a pace one can follow. */
async function dragSelect(page, rootSel, phrase, nth = 0) {
  const rects = await phraseRects(page, rootSel, phrase, nth);
  const [x0, y0, , h0] = rects[0];
  const [x1, y1, w1, h1] = rects.at(-1);
  await glide(page, x0 - 1, y0 + h0 / 2, 550);
  await sleep(150);
  await page.mouse.down();
  await glide(page, x1 + w1 + 1, y1 + h1 / 2, 500);
  await sleep(80);
  await page.mouse.up();
  await sleep(300);
}

/** Comment popup flow after a selection: click Comment, type, click Add. */
async function commentOnSelection(page, text) {
  console.log('  comment', ((Date.now() - T0) / 1000).toFixed(1));
  await clickAt(page, page.getByRole('button', { name: /^💬/ }), 450);
  await commentBox(page).waitFor();
  await sleep(200);
  await typeSlow(commentBox(page), text, 24);
  await sleep(250);
  await clickAt(page, addBtn(page), 450);
  await sleep(350);
}

async function openFile(page, filePath) {
  const parts = filePath.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = page.locator(`button[data-path="${parts.slice(0, i).join('/')}"]`);
    if ((await dir.getAttribute('aria-expanded')) !== 'true') await clickAt(page, dir, 550);
  }
  await clickAt(page, page.locator(`button[data-path="${filePath}"]`), 550);
  await sleep(250);
}

/** Opens the tree panel's folders (setup, off camera). */
async function expand(page, ...dirs) {
  for (const d of dirs) await page.locator(`button[data-path="${d}"]`).click();
}

/** Closes the file tree to give the open file the room (a click on its tool button, on camera). */
async function closeTree(page) {
  await clickAt(page, page.locator('#toggleTree'), 400);
  await sleep(150);
}

async function sendBatch(page) {
  await clickAt(page, page.locator('#cSend'), 650);
}

/**
 * Records a scene as a CDP screencast (Playwright's own video needs a separate ffmpeg download, which is not used here).
 * `setupThenPlay(page, start)` calls `start()` when the viewer's part begins; it returns when the final state is on screen.
 */
async function recordGif(browser, name, setupThenPlay, gifOpts) {
  const { ctx, page } = await openPage(browser, { record: true });
  const cdp = await ctx.newCDPSession(page);
  const dir = fs.mkdtempSync(path.join(work, `frames-${name}-`));
  const frames = [];
  cdp.on('Page.screencastFrame', (f) => {
    const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 3200, maxHeight: 2000, everyNthFrame: 1 });
  const marks = {};
  try { await setupThenPlay(page, () => { marks.from = Date.now() / 1000; }); } catch (e) { if (process.env.DEMO_DEBUG) await page.screenshot({ path: `/tmp/nbx/fail-${name}.png` }); throw e; }
  marks.to = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  await page.close();
  await ctx.close();
  const gif = path.join(OUT, `${name}.gif`);
  const dur = framesToGif(frames, marks, gif, dir, gifOpts);
  console.log(`${name}.gif  ${dur.toFixed(1)} s  ${(fs.statSync(gif).size / 1e6).toFixed(2)} MB`);
}

// ---- scenes ------------------------------------------------------------------------------------------------------
const scenes = {
  async 'annotate-text'(browser) {
    await recordGif(browser, 'annotate-text', async (page, start) => {
      await ask(page, TEXT.intro);
      await ask(page, TEXT.ask);
      await page.mouse.move(800, 800);
      await sleep(300);
      start();
      await sleep(400); // the reply, as the viewer arrives
      const reply = '[data-kind="assistant"]';
      const L = (m) => console.log('  ', m, ((Date.now() - T0) / 1000).toFixed(1));
      L('start');
      await dragSelect(page, reply, 'retries up to five times and then throws an error.', -1);
      L('sel1');
      await commentOnSelection(page, TEXT.heroC1);
      L('c1');
      await dragSelect(page, reply, 'a restart loses every link.', -1);
      L('sel2');
      await commentOnSelection(page, TEXT.heroC2);
      L('c2');
      await sleep(500);
      await sendBatch(page);
      L('sent');
      await waitDone(page, 2);
      L('done');
      await sleep(200);
    });
  },

  async 'annotate-code'(browser) {
    await recordGif(browser, 'annotate-code', async (page, start) => {
      await expand(page, 'src');
      await page.mouse.move(300, 600);
      start();
      await sleep(300);
      await openFile(page, 'src/store.ts');
      await closeTree(page);
      const code = '[data-file-path="src/store.ts"] pre';
      await sleep(400);
      await dragSelect(page, code, 'if (links.has(code)) continue;');
      await commentOnSelection(page, TEXT.codeC);
      await sleep(500);
      await sendBatch(page);
      await waitDone(page, 1);
      await sleep(200);
    });
  },

  async 'annotate-image'(browser) {
    await recordGif(browser, 'annotate-image', async (page, start) => {
      await expand(page, 'design');
      await page.mouse.move(300, 600);
      start();
      await sleep(300);
      await openFile(page, 'design/landing.png');
      await closeTree(page);
      const img = page.locator('[data-pane="file:design/landing.png"] img');
      await img.waitFor();
      await sleep(500);
      await clickAt(page, page.getByRole('button', { name: /^Mark up$/ }), 600);
      await page.locator('svg[data-markup-layer]').waitFor();
      await sleep(150);
      // the Shorten button (and, in the video, the result card): natural px of the picture -> client px of the shown image
      const b = await img.boundingBox();
      const box = await naturalBox(browser, landingHtml(), 800, 540, '.cta', 8);
      const k = b.width / 800;
      await drawRect(page, b.x + box.x * k, b.y + box.y * k, box.width * k, box.height * k);
      await commentOnMark(page, TEXT.imgC);
      // and the result card outlined point by point with the Mask tool
      await clickAt(page, page.getByRole('toolbar', { name: /./ }).getByRole('button', { name: /^Mask/ }), 600);
      const card = await naturalBox(browser, landingHtml(), 800, 540, '.result', 5);
      const [x0, y0, x1, y1] = [b.x + card.x * k, b.y + card.y * k, b.x + (card.x + card.width) * k, b.y + (card.y + card.height) * k];
      // a tag-like outline, then the first point again to close it. Points well apart: two clicks within 40 px and 0.5 s
      // are a double-click to the tool (it closes the shape there)
      const mid = (y0 + y1) / 2;
      const pts = [[x0, y0], [x1 - 40, y0], [x1 + 16, mid], [x1 - 40, y1], [x0, y1], [x0, y0]];
      for (const [x, y] of pts) {
        await glide(page, x, y, 420);
        await page.mouse.down();
        await page.mouse.up();
        await sleep(120);
      }
      await sleep(250);
      await commentOnMark(page, TEXT.maskC);
      await page.keyboard.press('Escape');
      await sleep(250);
      await sendBatch(page);
      await waitDone(page, 1);
      await sleep(200);
    });
  },

  async 'annotate-video'(browser) {
    await recordGif(browser, 'annotate-video', async (page, start) => {
      await expand(page, 'media');
      await page.mouse.move(300, 600);
      start();
      await sleep(300);
      await openFile(page, 'media/flow.mp4');
      await closeTree(page);
      const video = page.locator('[data-pane="file:media/flow.mp4"] video');
      await video.waitFor();
      await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
      await video.evaluate((e) => { e.muted = true; });
      const playBtn = page.locator('[data-player-bar] button').first();
      await sleep(150);
      // play, and pause once the result is up
      await clickAt(page, playBtn, 450);
      await page.waitForFunction(() => document.querySelector('video').currentTime >= 2.7);
      await playBtn.click();
      await page.waitForFunction(() => document.querySelector('video').paused);
      await sleep(150);
      await clickAt(page, page.getByRole('button', { name: /^Mark up$/ }), 600);
      await page.locator('svg[data-markup-layer]').waitFor();
      await sleep(150);
      const vb = await contentBox(video);
      const r = await naturalBox(browser, flowHtml(), 800, 500, '#r', 6);
      const k = vb.width / 800;
      await drawRect(page, vb.x + r.x * k, vb.y + r.y * k, r.width * k, r.height * k);
      await commentOnMark(page, TEXT.vidC);
      await page.keyboard.press('Escape');
      await sleep(250);
      await sendBatch(page);
      await waitDone(page, 1);
      await sleep(200);
    });
  },

  async 'video-editor'(browser) {
    await recordGif(browser, 'video-editor', async (page, start) => {
      await expand(page, 'media');
      await page.mouse.move(300, 600);
      start();
      await sleep(300);
      await openFile(page, CUT_PATH);
      await closeTree(page);
      const pane = page.locator(`[data-pane="file:${CUT_PATH}"]`);
      const clip = (id) => pane.locator(`[data-clip="${id}"]`);
      await page.waitForFunction(() => document.querySelectorAll('[data-wave]').length >= 2, null, { timeout: 30000 });
      await sleep(700);
      // the playhead into the title card, then the voice a little louder: drag its gain line up
      const ruler = await pane.locator('[data-ruler]').boundingBox();
      const pps = Number(await pane.locator('[data-timeline]').getAttribute('data-pps'));
      await glide(page, ruler.x + 1.5 * pps, ruler.y + ruler.height / 2, 550);
      await page.mouse.down();
      await page.mouse.up();
      await sleep(400);
      const g = await clip('c4').locator('[data-gain]').boundingBox();
      await glide(page, g.x + g.width * 0.6, g.y + g.height / 2, 650);
      await sleep(120);
      await page.mouse.down();
      await page.mouse.move(g.x + g.width * 0.6, g.y + g.height / 2 - 4, { steps: 12 });
      await sleep(500);
      await snap(page, 'cut-gain');
      await page.mouse.up();
      await sleep(300);
      // play: the title, the screen recording with the logo over it, the level meter moving
      await clickAt(page, pane.getByRole('button', { name: /^Play/ }), 500);
      await sleep(4600);
      await clickAt(page, pane.getByRole('button', { name: /^Pause/ }), 400);
      await sleep(250);
      // a comment on the music clip, sent to the agent
      const m = await clip('c5').boundingBox();
      await glide(page, m.x + m.width * 0.3, m.y + m.height * 0.75, 550);
      await page.mouse.down();
      await page.mouse.up();
      await sleep(300);
      await page.keyboard.press('m');
      await commentBox(page).waitFor();
      await sleep(250);
      await typeSlow(commentBox(page), TEXT.cutC, 24);
      await sleep(200);
      await snap(page, 'cut-typed');
      await page.keyboard.press('ControlOrMeta+Enter'); // a click on Add here would land on the timeline under the popup first
      await sleep(350);
      await snap(page, 'cut-added');
      // a click on the timeline's empty space lets the selection go, so the agent's change shows on its own
      const lane = await clip('c5').boundingBox();
      await glide(page, lane.x + lane.width + 120, lane.y + lane.height / 2, 500);
      await page.mouse.down();
      await page.mouse.up();
      await sleep(250);
      await sendBatch(page);
      await waitDone(page, 1);
      // the agent's write of the edit (a fake agent writes nothing itself)
      const file = path.join(PROJECT, CUT_PATH);
      fs.writeFileSync(file, JSON.stringify(agentCut(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2) + '\n');
      await sleep(600);
      await clickAt(page, page.locator(`[data-tab="file:${CUT_PATH}"]`), 600);
      // the highlight of what the agent changed plays for about two seconds: the GIF ends near its brightest and holds it
      await pane.locator('[data-changed-mark]').first().waitFor();
      await sleep(300);
    }, { hold: 3 });
  },

  async 'voice-message'(browser, assets) {
    // a browser of its own: its fake microphone plays the generated voice once
    const b = await chromium.launch({
      channel: 'chrome', headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${assets.voice}%noloop`],
    });
    try {
      console.log('  whisper warm-up:', await warmWhisper(assets.voice16));
      await recordGif(b, 'voice-message', async (page, start) => {
        await ask(page, TEXT.intro);
        await ask(page, TEXT.ask);
        await page.mouse.move(900, 700);
        await sleep(300);
        start();
        await sleep(500);
        await clickAt(page, page.getByTestId('mic'), 650);
        await page.getByTestId('record-bar').waitFor();
        await sleep(4300);
        await clickAt(page, page.getByRole('button', { name: 'Send the voice message' }), 450);
        // a click while the bar's wave still grows can miss: Enter sends too
        if (!(await page.getByTestId('record-bar').waitFor({ state: 'hidden', timeout: 1500 }).then(() => true, () => false))) await page.keyboard.press('Enter');
        await waitDone(page, 3);
        await sleep(400);
      });
    } finally {
      await b.close();
    }
  },

  async overview(browser) {
    const { ctx, page } = await openPage(browser);
    await ask(page, TEXT.intro);
    await ask(page, TEXT.ask);
    await expand(page, 'src');
    await openFile(page, 'src/store.ts');
    await dragSelect(page, '[data-file-path="src/store.ts"] pre', 'if (links.has(code)) continue;');
    await commentOnSelection(page, TEXT.codeC);
    await page.locator('[data-tab="chat"]').click();
    await sleep(300);
    const reply = '[data-kind="assistant"]';
    for (const [phrase, text] of [['retries up to five times and then throws an error.', TEXT.heroC1], ['a restart loses every link.', TEXT.heroC2]]) {
      await dragSelect(page, reply, phrase, -1);
      await commentOnSelection(page, text);
    }
    await page.mouse.move(1100, 900);
    await sleep(600);
    await page.evaluate(() => document.getElementById('demo-cursor')?.remove());
    await page.screenshot({ path: path.join(OUT, 'overview.png') });
    await ctx.close();
  },

  async 'slash-menu'(browser) {
    const { ctx, page } = await openPage(browser);
    await ask(page, TEXT.ask);
    await composer(page).click();
    await composer(page).pressSequentially('/');
    await page.getByRole('listbox').first().waitFor();
    await sleep(500);
    await page.evaluate(() => document.getElementById('demo-cursor')?.remove());
    await page.screenshot({ path: path.join(OUT, 'slash-menu.png') });
    await ctx.close();
  },

  async codex(browser) {
    const { ctx, page } = await openPage(browser);
    await composer(page).fill('Cap the retries when generating a short code, then run the tests.');
    await composer(page).press('Enter');
    await page.locator('[data-kind="permission"]').waitFor();
    await expand(page, 'src');
    await page.mouse.move(1100, 900);
    await sleep(600);
    await page.evaluate(() => document.getElementById('demo-cursor')?.remove());
    await page.screenshot({ path: path.join(OUT, 'codex.png') });
    await ctx.close();
  },
};

// ---- drawing on media ----------------------------------------------------------------------------------------------
async function drawRect(page, x, y, w, h) {
  const pad = 6;
  await glide(page, x - pad, y - pad, 550);
  await sleep(150);
  await page.mouse.down();
  await page.mouse.move(x + w + pad, y + h + pad, { steps: 26 });
  await sleep(100);
  await page.mouse.up();
  await sleep(300);
}

/** After a drawing: Enter opens the comment box, type, click Add. */
async function commentOnMark(page, text) {
  await page.keyboard.press('Enter');
  await commentBox(page).waitFor();
  await sleep(350);
  await typeSlow(commentBox(page), text, 24);
  await sleep(250);
  await clickAt(page, addBtn(page), 450);
  await sleep(500);
}

/** Box of `sel` in a page rendered from `html` (natural px), grown by `pad`. */
async function naturalBox(browser, html, w, h, sel, pad = 0) {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  await p.setContent(html);
  if (html.includes('window.render')) await p.evaluate(() => window.render(5));
  const b = await p.locator(sel).first().boundingBox();
  await p.close();
  return { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
}

/** The picture's content box in client px (object-fit: contain). */
const contentBox = (media) => media.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const [w, h] = el instanceof HTMLVideoElement ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight];
  const s = Math.min(r.width / w, r.height / h);
  return { x: r.x + (r.width - w * s) / 2, y: r.y + (r.height - h * s) / 2, width: w * s, height: h * s };
});

// ---- main ----------------------------------------------------------------------------------------------------------
function ensureBuilt() {
  const dist = path.join(REPO, 'web/dist/index.html');
  const newest = (dir) => execFileSync('find', [dir, '-type', 'f', '-newer', dist], { encoding: 'utf8' }).trim();
  if (!fs.existsSync(dist) || newest(path.join(REPO, 'web/src'))) execFileSync('npm', ['run', 'build', '-w', 'web'], { cwd: REPO, stdio: 'inherit' });
}

ensureBuilt();
// a Whisper install to copy for the voice message (never the running host: the scene's server starts its own in the temp state dir)
const whisper = process.env.DEMO_WHISPER ?? path.join(os.homedir(), '.nota-bene/whisper');
const haveWhisper = fs.existsSync(path.join(whisper, 'ready.json'));
let browser = null;
// Ctrl+C or a kill: stop the servers this run started (only those), then remove the demo folders and the work dir
let interrupted = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (interrupted) return;
    interrupted = true;
    console.error(`${sig}: stopping the demo servers and cleaning up`);
    await stopAll();
    await browser?.close().catch(() => {});
    cleanup(work);
    process.exit(130);
  });
}
let failed = false;
try {
  const assets = await prepare(chromium, work);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const [name, run] of Object.entries(scenes)) {
    if (only && !only.includes(name)) continue;
    if (name === 'voice-message' && !(haveWhisper && assets.voice)) {
      console.log(`${name}: skipped (needs a Whisper install, DEMO_WHISPER or ~/.nota-bene/whisper, and macOS \`say\`)`);
      continue;
    }
    const opts = name === 'codex' ? { codex: path.join(REPO, 'scripts/demo-media/codex-app-server.mjs') } : name === 'voice-message' ? { whisper } : {};
    let srv = null;
    try {
      srv = await startServer(work, assets.script, name, opts); // fresh state per scene
      await run(browser, assets);
    } catch (e) {
      failed = true;
      console.error(`${name} failed:`, e);
    } finally {
      if (srv) await srv.stop();
      else await stopAll(); // a start that failed half-way
    }
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser?.close();
  cleanup(work);
}
if (failed) process.exit(1);
