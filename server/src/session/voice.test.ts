import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_CAPABILITIES, type ServerEvent, type Voice } from '@nota-bene/shared';
import { mapFrames } from '../agent/claude/map.ts';
import type { ProviderBackend as AgentBackend } from '../agent/types.ts';
import { EventHub } from '../hub.ts';
import { createSessionManager } from '../session.ts';
import { VoiceIndex } from '../voice/index.ts';
import { VoiceFailure } from '../voice/transcribe.ts';

let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-voice-session-')); process.env.NOTA_BENE_HOME = home; });
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const noTasks = { stopTask: async () => {}, backgroundTask: async () => false, taskOutput: async () => ({ output: '', totalBytes: 0, truncated: false }) };
const noSessions = { capabilities: CLAUDE_CAPABILITIES, listSessions: async () => [], sessionInfo: async () => null, renameSession: async () => {}, subagent: async () => null };
const voice: Voice = { id: 'b'.repeat(64), ms: 1500, wave: Array(48).fill(3) };

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function setup(o: { speech: (id: string, lang: string) => Promise<string>; history?: ServerEvent[]; onInterrupt?: () => void; onSend?: () => void }) {
  const got: { uuid: string; text: string; priority?: string }[] = [];
  const backend: AgentBackend = {
    ...noSessions,
    history: async () => (o.history ?? []) as never,
    start: () => ({
      messages: mapFrames((async function* () { await new Promise(() => {}); })()),
      send: (m) => { o.onSend?.(); got.push(m); }, interrupt: async () => { o.onInterrupt?.(); }, setPermissionMode: async () => {}, supportedModels: async () => [], supportedCommands: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), ...noTasks, close() {},
    }),
  };
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind !== 'replay') events.push(e); } });
  const voices = new VoiceIndex({ file: path.join(home, 'voice.jsonl') });
  const make = (resume?: string) => createSessionManager({ hub, backend, cwd: home, resume, voices, speech: o.speech, closeTimeoutMs: 50, interruptTimeoutMs: 50 });
  return { got, events, make, voices, hub };
}

describe('voice messages', () => {
  it('the user event goes out at once with the voice; the agent gets the transcript after the voice-text', async () => {
    let say!: (t: string) => void;
    const langs: string[] = [];
    const { got, events, make } = setup({ speech: (_id, lang) => { langs.push(lang); return new Promise((r) => { say = r; }); } });
    const s = await make();
    expect(s.send({ id: 'v1', text: '', voice, lang: 'ru' })).toBeNull();
    expect(events.find((e) => e.kind === 'user')).toMatchObject({ id: 'v1', text: '', voice });
    expect(s.busy()).toBe(true);
    await until(() => langs.length === 1);
    expect(got).toEqual([]);
    say(' fix the test ');
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ uuid: 'v1', text: 'fix the test' });
    const vt = events.find((e) => e.kind === 'voice-text');
    expect(vt).toMatchObject({ kind: 'voice-text', id: 'v1', text: 'fix the test' });
    expect(events.indexOf(vt!)).toBeGreaterThan(events.findIndex((e) => e.kind === 'user'));
  });

  it('pending comments ride along: the agent gets the transcript, then their batch', async () => {
    const { got, make } = setup({ speech: async () => 'look at this' });
    const s = await make();
    expect(s.send({ id: 'v1', text: 'BATCH', voice, lang: 'en' })).toBeNull();
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ uuid: 'v1', text: 'look at this\n\nBATCH' });
  });

  it('a typed message sent after a voice one reaches the agent after it', async () => {
    let say!: (t: string) => void;
    const { got, make } = setup({ speech: () => new Promise((r) => { say = r; }) });
    const s = await make();
    s.send({ id: 'v1', text: '', voice, lang: 'en' });
    s.send({ id: 't1', text: 'and this' });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]);
    say('first');
    await until(() => got.length === 2);
    expect(got.map((m) => m.uuid)).toEqual(['v1', 't1']);
  });

  it('a forced voice message interrupts the running turn once it is transcribed, and its user event says force', async () => {
    let say!: (t: string) => void;
    const order: string[] = [];
    const { got, events, make } = setup({ speech: () => new Promise((r) => { say = r; }), onInterrupt: () => order.push('interrupt'), onSend: () => order.push('send') });
    const s = await make();
    s.send({ id: 'v1', text: '', voice, force: true, lang: 'en' });
    expect(events.find((e) => e.kind === 'user')).toMatchObject({ id: 'v1', force: true, voice });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]); // nothing is interrupted while it transcribes
    say('stop that');
    await until(() => got.length === 1);
    expect(order).toEqual(['interrupt', 'send']);
    expect(got[0]).toMatchObject({ uuid: 'v1', text: 'stop that', priority: 'now' });
  });

  it('a failed transcription tells why, settles the send as cancelled, and the agent gets nothing', async () => {
    const { got, events, make } = setup({ speech: async () => { throw new VoiceFailure('off'); } });
    const s = await make();
    s.send({ id: 'v1', text: '', voice, lang: 'en' });
    await until(() => events.some((e) => e.kind === 'agent' && e.e.t === 'cancelled'));
    expect(events.find((e) => e.kind === 'agent' && e.e.t === 'cancelled')).toMatchObject({ e: { sendId: 'v1' } });
    expect(events.some((e) => e.kind === 'agent' && e.e.t === 'turn-end')).toBe(false);
    expect(events.find((e) => e.kind === 'voice-text')).toMatchObject({ id: 'v1', error: 'off' });
    expect(events.some((e) => e.kind === 'server-error')).toBe(false);
    expect(got).toEqual([]);
    expect(s.busy()).toBe(false);
  });

  it('a failure while the agent works does not end its turn', async () => {
    const { events, make } = setup({ speech: async () => '' });
    const s = await make();
    s.send({ id: 't1', text: 'work' });
    s.send({ id: 'v1', text: '', voice, lang: 'en' });
    await until(() => events.some((e) => e.kind === 'voice-text'));
    await new Promise((r) => setTimeout(r, 20));
    expect(events.some((e) => e.kind === 'agent' && e.e.t === 'turn-end')).toBe(false);
    expect(s.busy()).toBe(true);
  });

  it('a transcript that starts with a slash is not run as a command', async () => {
    const { got, make } = setup({ speech: async () => '/clear the cache' });
    const s = await make();
    s.send({ id: 'v1', text: '', voice, lang: 'en' });
    await until(() => got.length === 1);
    expect(got[0]!.text.startsWith('/')).toBe(false);
    expect(got[0]!.text).toContain('/clear the cache');
  });

  it('silence is the error empty; any other failure is failed', async () => {
    const empty = setup({ speech: async () => '  ' });
    const s = await empty.make();
    s.send({ id: 'v1', text: '', voice, lang: 'en' });
    await until(() => empty.events.some((e) => e.kind === 'voice-text'));
    expect(empty.events.find((e) => e.kind === 'voice-text')).toMatchObject({ error: 'empty' });
    const broken = setup({ speech: async () => { throw new Error('worker died'); } });
    const b = await broken.make();
    b.send({ id: 'v2', text: '', voice, lang: 'en' });
    await until(() => broken.events.some((e) => e.kind === 'voice-text'));
    expect(broken.events.find((e) => e.kind === 'voice-text')).toMatchObject({ error: 'failed' });
  });

  it('a restart while it transcribes drops it: no hand-over, no voice-text in the new feed', async () => {
    let say!: (t: string) => void;
    const { got, events, make } = setup({ speech: () => new Promise((r) => { say = r; }) });
    const s = await make();
    s.send({ id: 'v1', text: '', voice, lang: 'en' });
    await new Promise((r) => setTimeout(r, 10));
    await s.restart();
    say('late');
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual([]);
    expect(events.some((e) => e.kind === 'voice-text')).toBe(false);
  });

  it('the index keeps the voice, and a resumed history gets it back on its user event', async () => {
    const history = [{ kind: 'user', id: 'v1', text: 'fix the test', ts: 0, historic: true }] as ServerEvent[];
    const first = setup({ speech: async () => 'fix the test' });
    const s = await first.make();
    s.send({ id: 'v1', text: '', voice, lang: 'en' });
    await until(() => first.got.length === 1);
    expect(first.voices.get('v1')).toEqual(voice);
    const again = setup({ speech: async () => '', history });
    await again.make('11111111-1111-1111-1111-111111111111');
    const user = (again.hub as unknown as { history: ServerEvent[] }).history.find((e) => e.kind === 'user');
    expect(user).toMatchObject({ id: 'v1', text: 'fix the test', voice });
  });

  it('a replay whose ids are not ours still gets the voices, by what they said, each once', async () => {
    const first = setup({ speech: async () => 'fix the test' });
    const s = await first.make();
    s.send({ id: 'v1', text: '', voice, lang: 'en' });
    await until(() => first.got.length === 1);
    const other: Voice = { ...voice, id: 'c'.repeat(64), ms: 900 };
    s.send({ id: 'v2', text: '', voice: other, lang: 'en' });
    await until(() => first.got.length === 2);
    const history = [
      { kind: 'user', id: 'omp-1', text: 'fix the test', ts: 0, historic: true },
      { kind: 'user', id: 'omp-2', text: 'typed by hand', ts: 0, historic: true },
      { kind: 'user', id: 'omp-3', text: 'fix the test', ts: 0, historic: true },
      { kind: 'user', id: 'omp-4', text: 'fix the test', ts: 0, historic: true },
    ] as ServerEvent[];
    const resumed = setup({ speech: async () => '', history });
    await resumed.make('11111111-1111-1111-1111-111111111111');
    const users = (resumed.hub as unknown as { history: ServerEvent[] }).history.filter((e) => e.kind === 'user');
    expect(users.map((u) => (u as { voice?: Voice }).voice?.id)).toEqual([voice.id, undefined, other.id, undefined]);
  });

  it('a reused id is refused before anything happens', async () => {
    const { events, make } = setup({ speech: async () => 'x' });
    const s = await make();
    s.send({ id: 'v1', text: '', voice, lang: 'en' });
    expect(() => s.send({ id: 'v1', text: '', voice, lang: 'en' })).toThrow();
    expect(events.filter((e) => e.kind === 'user')).toHaveLength(1);
  });
});
