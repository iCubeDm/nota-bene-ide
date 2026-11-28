import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CLAUDE_CAPABILITIES, PROTOCOL, type Capabilities, type ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
import { HistoryArchive } from './archive.ts';
import { agentServer } from './testing.ts';
import { tmpDirNames } from './tmpImage.ts';
import { whisperDir } from './dictation/install.ts';
import { WHISPER_MODEL, WHISPER_REVISION, WHISPER_VERSION } from './dictation/whisper.ts';
import { setDictationLangPref, setWhisperPref } from './prefs.ts';

let home: string;
let dist: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-server-home-'));
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-server-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

async function boot(extra: { ffmpeg?: () => string | null } = {}) {
  const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: dist, ffmpeg: () => null, ...extra });
  closers.push(s.close);
  return s;
}

type Client = { ws: WebSocket; events: ServerEvent[] };
async function connect(url: string, query = ''): Promise<Client> {
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws' + query);
  const events: ServerEvent[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  closers.push(async () => { ws.terminate(); });
  return { ws, events };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const isResult = (e: ServerEvent) => e.kind === 'agent' && e.e.t === 'turn-end';

describe('server', () => {
  it('hello carries dictation: whisper only when it is on and ready', async () => {
    const dictation = async () => {
      const c = await connect((await boot()).url);
      await until(() => c.events.some((e) => e.kind === 'hello'));
      return (c.events.find((e) => e.kind === 'hello') as { capabilities: Capabilities }).capabilities.dictation;
    };
    expect(await dictation()).toBeUndefined();
    setWhisperPref(true); // on, but not installed
    expect(await dictation()).toBeUndefined();
    fs.mkdirSync(whisperDir(), { recursive: true });
    fs.writeFileSync(path.join(whisperDir(), 'ready.json'), JSON.stringify({ version: WHISPER_VERSION, model: WHISPER_MODEL, revision: WHISPER_REVISION }));
    expect(await dictation()).toBe('whisper');
    setWhisperPref(false);
    expect(await dictation()).toBeUndefined();
  });

  it('hello carries dictationLang once it is chosen, and not before', async () => {
    const hello = async () => {
      const c = await connect((await boot()).url);
      await until(() => c.events.some((e) => e.kind === 'hello'));
      return c.events.find((e) => e.kind === 'hello') as { dictationLang?: string };
    };
    expect((await hello()).dictationLang).toBeUndefined();
    setDictationLangPref('auto');
    expect((await hello()).dictationLang).toBe('auto');
    setDictationLangPref('ru');
    expect((await hello()).dictationLang).toBe('ru');
  });

  it('chat round-trip over ws', async () => {
    const s = await boot();
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => c.events.some(isResult));
    expect(c.events.some((e) => e.kind === 'user' && e.id === 'u1')).toBe(true);
  });

  it('malformed message does not kill the server', async () => {
    const s = await boot();
    const c = await connect(s.url);
    c.ws.send('{nope');
    c.ws.send('{"type":"x"}');
    await until(() => c.events.filter((e) => e.kind === 'server-error').length === 2);
    const r = await fetch(`${s.url}/info`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ root: '/proj' });
  });

  it('/info tells pending, last and replies: fresh, after a turn, and while an ask waits', async () => {
    const info = async (url: string) => (await (await fetch(`${url}/info`)).json()) as { pending: boolean; last: { role: string; text: string; at: number } | null; replies: number };
    const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello\n\n**world**' }, { text: 'ok', ask: { toolName: 'Bash', input: { command: 'ls' } } }]), webDist: dist });
    closers.push(s.close);
    expect(await info(s.url)).toMatchObject({ pending: false, last: null, replies: 0 });
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => c.events.some(isResult));
    const done = await info(s.url);
    expect(done).toMatchObject({ pending: false, replies: 1, last: { role: 'assistant', text: 'hello **world**' } });
    expect(typeof done.last!.at).toBe('number');
    c.ws.send(JSON.stringify({ type: 'send', id: 'u2', text: 'run' }));
    await until(() => c.events.some((e) => e.kind === 'permission'));
    expect((await info(s.url)).pending).toBe(true);
    const p = c.events.find((e) => e.kind === 'permission') as Extract<ServerEvent, { kind: 'permission' }>;
    c.ws.send(JSON.stringify({ type: 'permission', id: p.id, allow: true }));
    await until(() => c.events.filter(isResult).length === 2);
    expect((await info(s.url)).pending).toBe(false);
  });

  it('/info lists the open asks; POST /permission answers one; a settled id is 409', async () => {
    const info = async (url: string) => (await (await fetch(`${url}/info`)).json()) as { asks?: { id: string }[] };
    const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'ok', ask: { toolName: 'Bash', input: { command: 'ls' } } }]), webDist: dist });
    closers.push(s.close);
    expect((await info(s.url)).asks).toBeUndefined();
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'run' }));
    await until(() => c.events.some((e) => e.kind === 'permission'));
    const p = c.events.find((e) => e.kind === 'permission') as Extract<ServerEvent, { kind: 'permission' }>;
    expect((await info(s.url)).asks).toEqual([{ id: p.id, toolName: 'Bash', input: { command: 'ls' } }]);
    const post = (body: unknown) => fetch(`${s.url}/permission`, { method: 'POST', headers: { origin: s.server, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ id: 1 })).status).toBe(400);
    expect((await fetch(`${s.url}/permission`)).status).toBe(405);
    expect((await post({ id: p.id, allow: true })).status).toBe(200);
    await until(() => c.events.some(isResult));
    expect((await info(s.url)).asks).toBeUndefined();
    expect((await post({ id: p.id, allow: true })).status).toBe(409);
  });

  it('/info clips a long input in asks', async () => {
    const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'ok', ask: { toolName: 'Write', input: { content: 'x'.repeat(5000), n: 3 } } }]), webDist: dist });
    closers.push(s.close);
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'run' }));
    await until(() => c.events.some((e) => e.kind === 'permission'));
    const j = (await (await fetch(`${s.url}/info`)).json()) as { asks: { input: { content: string; n: number } }[] };
    expect(j.asks[0]!.input.content).toHaveLength(2001);
    expect(j.asks[0]!.input.n).toBe(3);
  });

  it('POST /seen (the phone\'s Mark read) marks the open session seen and tells every socket', async () => {
    const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'one' }, { text: 'two' }]), webDist: dist, resume: '33333333-3333-4333-8333-333333333333' });
    closers.push(s.close);
    const info = async () => (await (await fetch(`${s.url}/info`)).json()) as { session: string; unseen: number };
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => c.events.some(isResult));
    const first = await info();
    expect(first.unseen).toBe(1);
    const before = c.events.filter((e) => e.kind === 'seen').length;
    const seen = await fetch(`${s.url}/seen`, { method: 'POST', headers: { origin: s.server, 'content-type': 'application/json' }, body: JSON.stringify({ session: first.session }) });
    expect(seen.status).toBe(200);
    expect((await info()).unseen).toBe(0);
    await until(() => c.events.filter((e) => e.kind === 'seen').length > before);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u2', text: 'again' }));
    await until(() => c.events.filter(isResult).length === 2);
    expect((await info()).unseen).toBe(1);
  });

  it('a new socket gets the current stats, and stats never enter the replay', async () => {
    const hot = { used: 180000, max: 200000, pct: 90 };
    const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello', context: hot }]), webDist: dist });
    closers.push(s.close);
    const a = await connect(s.url);
    a.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => a.events.some((e) => e.kind === 'stats' && e.stats.context?.pct === 90));
    const b = await connect(s.url);
    await until(() => b.events.some((e) => e.kind === 'stats'));
    expect(b.events.find((e) => e.kind === 'stats')).toMatchObject({ stats: { context: hot } });
    const replay = b.events.find((e) => e.kind === 'replay') as Extract<ServerEvent, { kind: 'replay' }>;
    expect(replay.events.some((e) => e.kind === 'stats')).toBe(false);
  });

  it('a second client gets the replay', async () => {
    const s = await boot();
    const a = await connect(s.url);
    a.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => a.events.some(isResult));
    const b = await connect(s.url);
    await until(() => b.events.length > 0);
    const first = b.events[0]!;
    expect(first.kind).toBe('replay');
    if (first.kind === 'replay') expect(first.events.some((e) => e.kind === 'user' && e.id === 'u1')).toBe(true);
  });

  it('every new socket hears hello with the protocol, after the state it is sent on connect', async () => {
    const s = await boot();
    const a = await connect(s.url);
    await until(() => a.events.some((e) => e.kind === 'hello'));
    const kinds = a.events.map((e) => e.kind);
    expect(a.events.find((e) => e.kind === 'hello')).toEqual({ kind: 'hello', protocol: PROTOCOL, capabilities: { ...CLAUDE_CAPABILITIES, ffmpeg: false }, tmpDirs: tmpDirNames() });
    expect(kinds.indexOf('hello')).toBeGreaterThan(kinds.indexOf('stats'));
  });

  it('every new socket gets the mode, and a mode message is applied and broadcast', async () => {
    const s = await boot();
    const a = await connect(s.url);
    await until(() => a.events.some((e) => e.kind === 'mode'));
    expect(a.events.find((e) => e.kind === 'mode')).toEqual({ kind: 'mode', mode: 'auto' });
    a.ws.send(JSON.stringify({ type: 'mode', mode: 'plan' }));
    await until(() => a.events.filter((e) => e.kind === 'mode').length === 2);
    const b = await connect(s.url);
    await until(() => b.events.some((e) => e.kind === 'mode'));
    expect(b.events.find((e) => e.kind === 'mode')).toEqual({ kind: 'mode', mode: 'plan' });
    const replay = b.events[0]!;
    if (replay.kind === 'replay') expect(replay.events.some((e) => e.kind === 'mode')).toBe(false); // live state, not history
  });

  it('every new socket gets the model list and the current model; a model message is applied, answered with its ack and broadcast', async () => {
    const models = [{ value: 'sonnet', name: 'Sonnet', description: '', efforts: ['low', 'high'] }, { value: 'opus', name: 'Opus', description: '' }] as const;
    const backend = fakeBackend([{ text: 'hello' }], { models: models.map((m) => ({ ...m, efforts: 'efforts' in m ? [...m.efforts] : undefined })) as never });
    const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend, webDist: dist });
    closers.push(s.close);
    const a = await connect(s.url);
    await until(() => a.events.some((e) => e.kind === 'models'));
    expect(a.events.find((e) => e.kind === 'model')).toEqual({ kind: 'model', model: null });
    a.ws.send(JSON.stringify({ type: 'model', model: 'sonnet', effort: 'high', id: 'm1' }));
    await until(() => a.events.some((e) => e.kind === 'model' && e.ack === 'm1'));
    expect(a.events.findLast((e) => e.kind === 'model')).toEqual({ kind: 'model', model: 'sonnet', effort: 'high', ack: 'm1' });
    const b = await connect(s.url); // a reload gets the list and the choice at once
    await until(() => b.events.some((e) => e.kind === 'model'));
    expect(b.events.find((e) => e.kind === 'model')).toEqual({ kind: 'model', model: 'sonnet', effort: 'high' });
    expect(b.events.find((e) => e.kind === 'models')).toMatchObject({ models: [{ value: 'sonnet' }, { value: 'opus' }] });
    expect(backend.setModels).toEqual(['sonnet']);
  });

  it('every new socket gets the slash commands, filtered: the user\'s first, the allowlisted builtins, nothing bound to a terminal', async () => {
    const backend = fakeBackend([{ text: 'hello' }], {
      commands: [
        { name: 'model', description: 'm', builtin: true }, { name: 'compact', description: 'c', argumentHint: '[how]', builtin: true },
        { name: 'ping', description: 'p' }, { name: 'doctor', description: 'd', builtin: true }, { name: 'color', description: 'x' },
      ],
      terminalCommands: ['doctor', 'color'],
    });
    const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend, webDist: dist });
    closers.push(s.close);
    const a = await connect(s.url);
    const want = { kind: 'commands', commands: [{ name: 'ping', description: 'p' }, { name: 'compact', description: 'c', hint: '[how]', builtin: true }] };
    await until(() => a.events.some((e) => e.kind === 'commands' && e.commands.length > 0));
    expect(a.events.findLast((e) => e.kind === 'commands')).toEqual(want);
    const b = await connect(s.url); // a later socket gets the list with the other state, not through the replay
    await until(() => b.events.some((e) => e.kind === 'commands'));
    expect(b.events.findLast((e) => e.kind === 'commands')).toEqual(want);
    const replay = b.events[0]!;
    if (replay.kind === 'replay') expect(replay.events.some((e) => e.kind === 'commands')).toBe(false);
  });

  it('an allow that carries a modified input still runs the original input', async () => {
    const seen: unknown[] = [];
    const base = fakeBackend([{ text: 'ok', ask: { toolName: 'Bash', input: { command: 'ls' } } }]);
    // the agent side: what the backend's ask resolves with is what the SDK adapter turns into updatedInput
    const backend = { ...base, start: (o: Parameters<typeof base.start>[0]) => base.start({ ...o, ask: async (...a) => { const r = await o.ask(...a); seen.push(r); return r; } }) };
    const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend, webDist: dist });
    closers.push(s.close);
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'run' }));
    await until(() => c.events.some((e) => e.kind === 'permission'));
    const p = c.events.find((e) => e.kind === 'permission') as Extract<ServerEvent, { kind: 'permission' }>;
    c.ws.send(JSON.stringify({ type: 'permission', id: p.id, allow: true, input: { command: 'rm -rf /' } }));
    await until(() => seen.length === 1);
    expect(seen[0]).toBe(true); // a plain allow: the adapter echoes the ORIGINAL input
  });

  const prevSup = process.env.NOTA_BENE_SUPERVISED;
  const prevLauncher = process.env.NOTA_BENE_LAUNCHER_PID;
  const restoreSup = () => {
    if (prevSup === undefined) delete process.env.NOTA_BENE_SUPERVISED; else process.env.NOTA_BENE_SUPERVISED = prevSup;
    if (prevLauncher === undefined) delete process.env.NOTA_BENE_LAUNCHER_PID; else process.env.NOTA_BENE_LAUNCHER_PID = prevLauncher;
  };
  // supervised = the env says so AND the launcher named in it is still our parent
  const supervise = (launcher = process.ppid) => {
    process.env.NOTA_BENE_SUPERVISED = '1';
    process.env.NOTA_BENE_LAUNCHER_PID = String(launcher);
  };

  it('/info.supervised follows NOTA_BENE_SUPERVISED, and only while the launcher is the parent', async () => {
    const s = await boot();
    const sup = async () => ((await (await fetch(`${s.url}/info`)).json()) as { supervised: boolean }).supervised;
    try {
      delete process.env.NOTA_BENE_SUPERVISED;
      expect(await sup()).toBe(false);
      supervise();
      expect(await sup()).toBe(true);
      supervise(process.ppid + 100000); // an orphan: its launcher is gone, init/launchd adopted it
      expect(await sup()).toBe(false);
    } finally {
      restoreSup();
    }
  });

  it('hello says whether ffmpeg is found (asked on every connect), and /cut/export is served', async () => {
    let bin: string | null = null;
    const s = await boot({ ffmpeg: () => bin });
    const ffmpegOf = async () => {
      const c = await connect(s.url);
      await until(() => c.events.some((e) => e.kind === 'hello'));
      return (c.events.find((e) => e.kind === 'hello') as { capabilities: Capabilities }).capabilities.ffmpeg;
    };
    expect(await ffmpegOf()).toBe(false);
    bin = '/usr/bin/ffmpeg';
    expect(await ffmpegOf()).toBe(true);
    expect(await (await fetch(`${s.url}/cut/export?path=a.nbcut.json`)).json()).toEqual({ ffmpeg: true, job: null });
  });

  it('a taken port rejects startServer with the listen error (instead of hanging)', async () => {
    const s = await boot();
    const port = Number(new URL(s.url).port);
    const err = await agentServer({ insecureNoAuth: true, cwd: '/proj', port, backend: fakeBackend([]), webDist: dist }).then(
      () => null,
      (e: NodeJS.ErrnoException) => e,
    );
    expect(err).toMatchObject({ code: 'EADDRINUSE', syscall: 'listen' });
  });

  describe('GET /history (R-M7-4)', () => {
    const user = (id: string): ServerEvent => ({ kind: 'user', id, text: id, ts: 1 });
    async function bootWithArchive() {
      const a = new HistoryArchive({ dir: path.join(home, 'history') });
      a.append('fake-session', [user('a')]);
      a.append('fake-session', [user('b')]);
      a.append('other-session', [user('x')]);
      const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: dist, resume: 'fake-session' });
      closers.push(s.close);
      return s;
    }
    const get = (s: { url: string }, q: string) => fetch(`${s.url}/history?${q}`);

    it('a new socket\'s replay carries earlier, and each page goes one segment back', async () => {
      const s = await bootWithArchive();
      const c = await connect(s.url);
      await until(() => c.events.some((e) => e.kind === 'hello'));
      expect(c.events[0]).toMatchObject({ kind: 'replay', earlier: 2 });
      const r = await get(s, 'session=fake-session&before=3');
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ events: [user('b')], segment: 2, more: true });
      expect(await (await get(s, 'session=fake-session&before=2')).json()).toEqual({ events: [user('a')], segment: 1, more: false });
      expect((await get(s, 'session=fake-session&before=1')).status).toBe(404);
    });

    it('history 409 for another session', async () => {
      const s = await bootWithArchive();
      const r = await get(s, 'session=other-session&before=2');
      expect(r.status).toBe(409);
      expect(await r.text()).not.toContain('x');
    });

    it('409 while the conversation has no id of its own: a fork before its first turn does not serve the source\'s archive', async () => {
      new HistoryArchive({ dir: path.join(home, 'history') }).append('fake-session', [user('a')]);
      const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: dist, resume: 'fake-session', fork: true });
      closers.push(s.close);
      expect((await get(s, 'session=fake-session&before=2')).status).toBe(409);
    });

    it('400 for a bad id or a bad before; 405 for a POST', async () => {
      const s = await bootWithArchive();
      for (const q of ['session=..%2Fx&before=2', 'before=2', 'session=fake-session', 'session=fake-session&before=0', 'session=fake-session&before=1.5', 'session=fake-session&before=abc']) {
        expect((await get(s, q)).status, q).toBe(400);
      }
      expect((await fetch(`${s.url}/history?session=fake-session&before=2`, { method: 'POST', headers: { origin: s.server } })).status).toBe(405);
    });
  });

  describe('POST /restart-server', () => {
    afterEach(restoreSup);
    const post = (url: string, origin?: string) =>
      fetch(`${url}/restart-server`, { method: 'POST', ...(origin ? { headers: { origin } } : {}) });

    it('409 when not supervised, and never exits', async () => {
      delete process.env.NOTA_BENE_SUPERVISED;
      const codes: number[] = [];
      const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([]), webDist: dist, exit: (c) => { codes.push(c); } });
      closers.push(s.close);
      expect((await post(s.url, s.server)).status).toBe(409);
      await new Promise((r) => setTimeout(r, 250));
      expect(codes).toEqual([]);
    });

    it('403 for a foreign Origin (and for none), even when supervised', async () => {
      supervise();
      const codes: number[] = [];
      const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([]), webDist: dist, exit: (c) => { codes.push(c); } });
      closers.push(s.close);
      expect((await post(s.url, 'http://evil.example')).status).toBe(403);
      expect((await post(s.url)).status).toBe(403);
      await new Promise((r) => setTimeout(r, 250));
      expect(codes).toEqual([]);
    });

    it('supervised: answers 200, then exits with 75', async () => {
      supervise();
      const codes: number[] = [];
      const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([]), webDist: dist, exit: (c) => { codes.push(c); } });
      closers.push(s.close);
      const r = await post(s.url, s.server);
      expect(r.status).toBe(200);
      expect(codes).toEqual([]); // the reply came first
      await until(() => codes.length === 1);
      expect(codes).toEqual([75]);
    });

    // gh-422: a restart while the agent works waits for the pause
    const long = () => fakeBackend([{ text: 'x'.repeat(4000), chunk: 1, delayMs: 5 }, { text: 'again' }]);
    const postJson = (url: string, p: string, body: unknown = {}) =>
      fetch(`${url}${p}`, { method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    // `pause=1`: a page of protocol 22+ that asks for the restart in its own pause (the phone and an older page do not)
    // a pending restart looks for a pause every EVERY ms (1 s in a real window); a wait of `quiet` outlasts several looks
    const EVERY = 100;
    const quiet = () => new Promise((r) => setTimeout(r, 3 * EVERY));
    const working = async (codes: number[], query = '?pause=1') => {
      supervise();
      const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: long(), webDist: dist, restartEveryMs: EVERY, exit: (c) => { codes.push(c); } });
      closers.push(s.close);
      const c = await connect(s.url, query);
      c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'work' }));
      await until(() => c.events.some((e) => e.kind === 'agent' && e.e.t === 'message-chunk'));
      return { s, c };
    };
    const info = async (url: string) => (await (await fetch(`${url}/info`)).json()) as { restartPending?: boolean };

    it('busy: pending, told to the page; the exit waits for the turn and then for the page to ask in its pause', async () => {
      const codes: number[] = [];
      const { s, c } = await working(codes);
      expect(c.events.filter((e) => e.kind === 'restart-pending')).toEqual([{ kind: 'restart-pending', pending: false }]); // on attach
      const r = await post(s.url, s.server);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, pending: true });
      await until(() => c.events.some((e) => e.kind === 'restart-pending' && e.pending));
      expect(await info(s.url)).toMatchObject({ restartPending: true });
      expect((await postJson(s.url, '/restart-server/pause')).status).toBe(409); // still busy
      await new Promise((r) => setTimeout(r, 300));
      expect(codes).toEqual([]);
      c.ws.send(JSON.stringify({ type: 'interrupt' }));
      await until(() => c.events.some(isResult));
      await quiet(); // a page is open: the server does not go by itself
      expect(codes).toEqual([]);
      expect((await postJson(s.url, '/restart-server/pause')).status).toBe(200);
      await until(() => codes.length === 1);
      expect(codes).toEqual([75]);
    });

    it('busy with no page open: exits 75 by itself at the next pause', async () => {
      const codes: number[] = [];
      const { s, c } = await working(codes);
      expect((await post(s.url, s.server)).status).toBe(200);
      c.ws.send(JSON.stringify({ type: 'interrupt' }));
      await until(() => c.events.some(isResult));
      c.ws.close();
      await until(() => codes.length === 1, 4000);
      expect(codes).toEqual([75]);
    });

    for (const [who, query] of [['the phone (no pause logic)', ''], ['a page of an older bundle', '?tab=old']] as const) {
      it(`busy with only ${who} attached: the server's own pause rule restarts, it waits for nobody's ask`, async () => {
        const codes: number[] = [];
        const { s, c } = await working(codes, query);
        expect(await (await post(s.url, s.server)).json()).toEqual({ ok: true, pending: true });
        c.ws.send(JSON.stringify({ type: 'interrupt' }));
        await until(() => c.events.some(isResult));
        await until(() => codes.length === 1, 4000);
        expect(codes).toEqual([75]);
      });
    }

    it('the asking page leaves: the server goes by its own rule from then on, though the phone is still attached', async () => {
      const codes: number[] = [];
      const { s, c } = await working(codes);
      const phone = await connect(s.url);
      await post(s.url, s.server);
      c.ws.send(JSON.stringify({ type: 'interrupt' }));
      await until(() => c.events.some(isResult));
      await quiet();
      expect(codes).toEqual([]); // the page will ask
      c.ws.close();
      await until(() => codes.length === 1, 4000);
      expect(codes).toEqual([75]);
      void phone; // attached throughout: it never held the restart
    });

    it('cancel: the pause does not restart', async () => {
      const codes: number[] = [];
      const { s, c } = await working(codes);
      await post(s.url, s.server);
      expect((await postJson(s.url, '/restart-server/cancel')).status).toBe(200);
      await until(() => c.events.filter((e) => e.kind === 'restart-pending').at(-1)?.kind === 'restart-pending' && !(c.events.filter((e) => e.kind === 'restart-pending').at(-1) as { pending: boolean }).pending);
      c.ws.send(JSON.stringify({ type: 'interrupt' }));
      await until(() => c.events.some(isResult));
      expect((await postJson(s.url, '/restart-server/pause')).status).toBe(409);
      c.ws.close();
      await quiet();
      expect(codes).toEqual([]);
      expect(await info(s.url)).toMatchObject({ restartPending: false });
    });

    // issue 499: a compaction ordered while the agent works, and the sends held behind it
    const users = (c: Client) => c.events.flatMap((e) => (e.kind === 'user' ? [e.text] : []));
    const lastOrder = (c: Client) => c.events.filter((e) => e.kind === 'compact-pending').at(-1);

    it('compact while working (held=1): pending, a later send held; at the pause the compaction runs, then the send', async () => {
      const codes: number[] = [];
      const { c } = await working(codes, '?pause=1&held=1');
      expect(lastOrder(c)).toEqual({ kind: 'compact-pending', pending: false, held: [] }); // on attach
      c.ws.send(JSON.stringify({ type: 'command', name: 'compact' }));
      await until(() => lastOrder(c)?.kind === 'compact-pending' && (lastOrder(c) as { pending: boolean }).pending);
      c.ws.send(JSON.stringify({ type: 'send', id: 'u2', text: 'after' }));
      c.ws.send(JSON.stringify({ type: 'send', id: 'u3', text: '/compact' })); // typed: the same order, again a no-op
      await until(() => c.events.filter((e) => e.kind === 'send-held').length === 2);
      expect(lastOrder(c)).toMatchObject({ pending: true, held: [{ id: 'u2', text: 'after' }] });
      expect(users(c)).toEqual(['work']); // the agent has not got it
      c.ws.send(JSON.stringify({ type: 'interrupt' }));
      await until(() => users(c).length === 3, 4000);
      expect(users(c)).toEqual(['work', '/compact', 'after']);
      expect(c.events.some((e) => e.kind === 'server-error')).toBe(false);
      await until(() => c.events.filter(isResult).length === 3);
      expect(lastOrder(c)).toEqual({ kind: 'compact-pending', pending: false, held: [] });
      expect(codes).toEqual([]);
    });

    it('an older page (no held=1): compact while working is refused and its sends go as before', async () => {
      const codes: number[] = [];
      const { c } = await working(codes);
      c.ws.send(JSON.stringify({ type: 'command', name: 'compact' }));
      await until(() => c.events.some((e) => e.kind === 'server-error' && e.where === 'busy'));
      c.ws.send(JSON.stringify({ type: 'send', id: 'u2', text: 'after' }));
      await until(() => users(c).length === 2);
      expect(c.events.some((e) => e.kind === 'send-held' || (e.kind === 'compact-pending' && e.pending))).toBe(false);
    });

    it('restart and compaction pending: the restart goes first; the order and the held send stay on disk for the next start', async () => {
      const codes: number[] = [];
      const { s, c } = await working(codes, '?held=1'); // no page that asks: the server goes by its own rule
      const id = ((await (await fetch(`${s.url}/info`)).json()) as { session: string }).session;
      expect(await (await post(s.url, s.server)).json()).toEqual({ ok: true, pending: true });
      c.ws.send(JSON.stringify({ type: 'command', name: 'compact' }));
      c.ws.send(JSON.stringify({ type: 'send', id: 'u2', text: 'after' }));
      await until(() => c.events.some((e) => e.kind === 'send-held'));
      c.ws.send(JSON.stringify({ type: 'interrupt' }));
      await until(() => codes.length === 1, 4000);
      expect(codes).toEqual([75]);
      expect(users(c)).toEqual(['work']); // neither the compaction nor the send went before the restart
      const rec = JSON.parse(fs.readFileSync(path.join(home, 'compact-pending', `${id}.json`), 'utf8'));
      expect(rec).toMatchObject({ compact: '/compact', held: [{ id: 'u2', text: 'after' }] });
    });

    it('another agent of the server, idle, is not held behind a restart waiting for this one: its sends go', async () => {
      const codes: number[] = [];
      const { s } = await working(codes, '?held=1');
      expect(await (await post(s.url, s.server)).json()).toEqual({ ok: true, pending: true });
      fs.mkdirSync(path.join(home, 'b'), { recursive: true });
      const b = await s.open({ provider: 'claude', cwd: path.join(home, 'b'), backend: fakeBackend([]) });
      const other = await connect(`${s.server}/a/${b}`, '?held=1');
      other.ws.send(JSON.stringify({ type: 'send', id: 'b1', text: 'hello' }));
      await until(() => users(other).length === 1);
      expect(other.events.some((e) => e.kind === 'send-held')).toBe(false);
      expect(codes).toEqual([]);
    });

    it('the busy one alone in the way (the other agents idle): its own sends are held, as in a lone window', async () => {
      const codes: number[] = [];
      const { s, c } = await working(codes, '?held=1');
      fs.mkdirSync(path.join(home, 'b'), { recursive: true });
      await s.open({ provider: 'claude', cwd: path.join(home, 'b'), backend: fakeBackend([]) });
      expect(await (await post(s.url, s.server)).json()).toEqual({ ok: true, pending: true });
      c.ws.send(JSON.stringify({ type: 'send', id: 'u2', text: 'after' }));
      await until(() => c.events.some((e) => e.kind === 'send-held'));
    });

    it('a typed /compact with instructions while working keeps them', async () => {
      const codes: number[] = [];
      const { c } = await working(codes, '?pause=1&held=1');
      c.ws.send(JSON.stringify({ type: 'send', id: 'u2', text: '/compact keep the API notes' }));
      await until(() => c.events.some((e) => e.kind === 'send-held'));
      c.ws.send(JSON.stringify({ type: 'interrupt' }));
      await until(() => users(c).length === 2, 4000);
      expect(users(c)).toEqual(['work', '/compact keep the API notes']);
    });

    it('a send while the ordered compaction itself runs waits for its end', async () => {
      const codes: number[] = [];
      supervise();
      const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'x'.repeat(4000), chunk: 1, delayMs: 5, compactMs: 600 }, { text: 'again' }]), webDist: dist, restartEveryMs: EVERY, exit: (code) => { codes.push(code); } });
      closers.push(s.close);
      const c = await connect(s.url, '?pause=1&held=1');
      c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'work' }));
      await until(() => c.events.some((e) => e.kind === 'agent' && e.e.t === 'message-chunk'));
      c.ws.send(JSON.stringify({ type: 'command', name: 'compact' }));
      c.ws.send(JSON.stringify({ type: 'interrupt' }));
      await until(() => users(c).includes('/compact'), 4000);
      c.ws.send(JSON.stringify({ type: 'send', id: 'u2', text: 'after' }));
      await until(() => c.events.some((e) => e.kind === 'send-held' && e.id === 'u2'));
      expect(users(c)).toEqual(['work', '/compact']);
      await until(() => users(c).length === 3, 4000);
      expect(users(c)).toEqual(['work', '/compact', 'after']);
    });

    it('Clear while a compaction is pending (the agent idle, a `!` run going): refused, button and typed', async () => {
      const codes: number[] = [];
      const { c } = await working(codes, '?pause=1&held=1');
      c.ws.send(JSON.stringify({ type: 'command', name: 'compact' }));
      c.ws.send(JSON.stringify({ type: 'shell-run', id: 'r1', cmd: 'sleep 2' }));
      await until(() => c.events.some((e) => e.kind === 'shell-start'));
      c.ws.send(JSON.stringify({ type: 'interrupt' }));
      await until(() => c.events.some(isResult));
      c.ws.send(JSON.stringify({ type: 'command', name: 'clear' }));
      await until(() => c.events.some((e) => e.kind === 'server-error' && e.where === 'busy'));
      c.ws.send(JSON.stringify({ type: 'send', id: 'u2', text: '/clear' }));
      await until(() => c.events.some((e) => e.kind === 'send-refused' && e.id === 'u2'));
      expect(users(c)).toEqual(['work']);
      expect(lastOrder(c)).toMatchObject({ pending: true });
    });

    it('cancel (held=1): the held send goes at once, no compaction', async () => {
      const codes: number[] = [];
      const { c } = await working(codes, '?pause=1&held=1');
      c.ws.send(JSON.stringify({ type: 'command', name: 'compact' }));
      c.ws.send(JSON.stringify({ type: 'send', id: 'u2', text: 'after' }));
      await until(() => c.events.some((e) => e.kind === 'send-held'));
      c.ws.send(JSON.stringify({ type: 'compact-cancel' }));
      await until(() => users(c).length === 2);
      c.ws.send(JSON.stringify({ type: 'interrupt' }));
      await until(() => c.events.filter(isResult).length === 2);
      await quiet();
      expect(users(c)).toEqual(['work', 'after']);
    });

    it('now: exits 75 at once mid-turn and leaves the mark of the cut turn', async () => {
      const codes: number[] = [];
      const { s } = await working(codes);
      const id = ((await (await fetch(`${s.url}/info`)).json()) as { session: string | null }).session;
      await until(() => fs.existsSync(path.join(home, 'turns-open')) && fs.readdirSync(path.join(home, 'turns-open')).length > 0);
      const r = await postJson(s.url, '/restart-server', { now: true });
      expect(r.status).toBe(200);
      await until(() => codes.length === 1);
      expect(codes).toEqual([75]);
      await new Promise((r) => setTimeout(r, 500)); // the close ends the turn: the mark must stay
      expect(fs.readdirSync(path.join(home, 'turns-open'))).toEqual([id]);
    });

    it('a turn that ends normally leaves no mark', async () => {
      const codes: number[] = [];
      const { c } = await working(codes);
      await until(() => fs.existsSync(path.join(home, 'turns-open')) && fs.readdirSync(path.join(home, 'turns-open')).length > 0);
      c.ws.send(JSON.stringify({ type: 'interrupt' }));
      await until(() => c.events.some(isResult));
      await until(() => fs.readdirSync(path.join(home, 'turns-open')).length === 0);
    });
  });

  describe('POST /stop', () => {
    afterEach(restoreSup);
    const post = (url: string, origin?: string) => fetch(`${url}/stop`, { method: 'POST', ...(origin ? { headers: { origin } } : {}) });

    it('answers 200, then exits with 0, without a supervisor too', async () => {
      delete process.env.NOTA_BENE_SUPERVISED;
      const codes: number[] = [];
      const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([]), webDist: dist, exit: (c) => { codes.push(c); } });
      closers.push(s.close);
      const r = await post(s.url, s.server);
      expect(r.status).toBe(200);
      expect(codes).toEqual([]); // the reply came first
      await until(() => codes.length === 1);
      expect(codes).toEqual([0]);
    });

    it('403 for a foreign Origin (and for none), 405 for a GET, and never exits', async () => {
      const codes: number[] = [];
      const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([]), webDist: dist, exit: (c) => { codes.push(c); } });
      closers.push(s.close);
      expect((await post(s.url, 'http://evil.example')).status).toBe(403);
      expect((await post(s.url)).status).toBe(403);
      expect((await fetch(`${s.url}/stop`)).status).toBe(405);
      await new Promise((r) => setTimeout(r, 250));
      expect(codes).toEqual([]);
    });
  });

  describe('capabilities (R-M7-15)', () => {
    const bootCaps = async (capabilities: Partial<Capabilities>) => {
      const backend = fakeBackend([{ text: 'hello' }], { capabilities });
      const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend, webDist: dist });
      closers.push(s.close);
      return { s, backend };
    };

    it('hello carries the backend capabilities; the fake mirrors Claude by default', async () => {
      const a = await connect((await boot()).url);
      await until(() => a.events.some((e) => e.kind === 'hello'));
      expect(a.events.find((e) => e.kind === 'hello')).toMatchObject({ protocol: PROTOCOL, capabilities: CLAUDE_CAPABILITIES });
      const { s } = await bootCaps({ compact: false, modes: ['default'] });
      const b = await connect(s.url);
      await until(() => b.events.some((e) => e.kind === 'hello'));
      expect(b.events.find((e) => e.kind === 'hello')).toMatchObject({ capabilities: { ...CLAUDE_CAPABILITIES, compact: false, modes: ['default'] } });
    });

    it('refuses a command the agent cannot do, with a server-error naming the capability', async () => {
      const { s } = await bootCaps({ compact: false, clear: false });
      const c = await connect(s.url);
      c.ws.send(JSON.stringify({ type: 'command', name: 'compact' }));
      c.ws.send(JSON.stringify({ type: 'command', name: 'clear' }));
      await until(() => c.events.filter((e) => e.kind === 'server-error' && e.where === 'capability').length === 2);
      expect(c.events.some((e) => e.kind === 'user')).toBe(false);
    });

    it('refuses a mode outside `modes`, but still answers it (the sender waits for its ack)', async () => {
      const { s, backend } = await bootCaps({ modes: ['default'] });
      const c = await connect(s.url);
      c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
      await until(() => c.events.some(isResult));
      c.ws.send(JSON.stringify({ type: 'mode', mode: 'plan', id: 'm1' }));
      await until(() => c.events.some((e) => e.kind === 'server-error' && e.where === 'capability'));
      await until(() => c.events.some((e) => e.kind === 'mode' && e.ack === 'm1'));
      expect(backend.setModes).toEqual([]);
    });

    it('refuses a model message when the agent cannot switch models, but still answers it', async () => {
      const { s, backend } = await bootCaps({ models: false });
      const c = await connect(s.url);
      c.ws.send(JSON.stringify({ type: 'model', model: 'opus', id: 'x1' }));
      await until(() => c.events.some((e) => e.kind === 'server-error' && e.where === 'capability'));
      await until(() => c.events.some((e) => e.kind === 'model' && e.ack === 'x1'));
      expect(backend.setModels).toEqual([]);
    });

    it('--fork is dropped when the agent cannot fork, kept when it can', async () => {
      for (const [fork, want] of [[false, undefined], [true, true]] as const) {
        const backend = fakeBackend([{ text: 'x' }], { capabilities: { fork } });
        const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend, webDist: dist, resume: 'abc', fork: true });
        closers.push(s.close);
        expect(backend.starts[0]?.fork).toBe(want);
      }
    });

    it('refuses idle-compact when the agent has none', async () => {
      const { s } = await bootCaps({ idleCompact: false });
      const c = await connect(s.url);
      c.ws.send(JSON.stringify({ type: 'idle-compact', on: false }));
      await until(() => c.events.some((e) => e.kind === 'server-error' && e.where === 'capability'));
    });
  });
});

describe('server: tracked commands while busy', () => {
  it('a /clear typed during a turn gets send-refused busy on the asking socket; nothing reaches the feed', async () => {
    const backend = fakeBackend([{ text: 'x'.repeat(3000), chunk: 1, delayMs: 5 }]);
    const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend, webDist: dist });
    closers.push(s.close);
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'work' }));
    await until(() => c.events.some((e) => e.kind === 'user'));
    c.ws.send(JSON.stringify({ type: 'send', id: 'c1', text: '/clear' }));
    await until(() => c.events.some((e) => e.kind === 'send-refused'));
    expect(c.events.find((e) => e.kind === 'send-refused')).toEqual({ kind: 'send-refused', id: 'c1', reason: 'busy' });
    expect(c.events.filter((e) => e.kind === 'user')).toHaveLength(1);
    c.ws.send(JSON.stringify({ type: 'interrupt' }));
  });
});
