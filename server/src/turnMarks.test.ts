import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TurnMarks, changesWork } from './turnMarks.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-turnmarks-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function make(id: string | null = 's1') {
  const st = { working: false, id };
  const m = new TurnMarks({ dir, working: () => st.working, session: () => st.id });
  return { m, st };
}

describe('TurnMarks', () => {
  it('a turn leaves a mark while it runs and removes it when it ends', () => {
    const { m, st } = make();
    st.working = true;
    m.check();
    expect(fs.existsSync(path.join(dir, 's1'))).toBe(true);
    st.working = false;
    m.check();
    expect(fs.existsSync(path.join(dir, 's1'))).toBe(false);
  });

  it('a mark left by an earlier process survives the start, and take() reads it once', () => {
    fs.writeFileSync(path.join(dir, 's1'), '{}');
    const { m } = make();
    m.check(); // idle at start: not a transition, the old mark stays for the resume to read
    expect(m.take('s1')).toBe(true);
    expect(m.take('s1')).toBe(false);
    expect(m.take('other')).toBe(false);
  });

  it('take of a mark this process keeps: the next check writes it again while the work goes on', () => {
    const { m, st } = make();
    st.working = true;
    m.check();
    expect(m.take('s1')).toBe(true);
    m.check();
    expect(fs.existsSync(path.join(dir, 's1'))).toBe(true);
  });

  it('freeze keeps the mark of a turn cut by the exit', () => {
    const { m, st } = make();
    st.working = true;
    m.check();
    m.freeze();
    st.working = false;
    m.check();
    expect(fs.existsSync(path.join(dir, 's1'))).toBe(true);
  });

  it('no session id yet: nothing written until one comes; a new id moves the mark', () => {
    const { m, st } = make(null);
    st.working = true;
    m.check();
    expect(fs.readdirSync(dir)).toEqual([]);
    st.id = 's2';
    m.check();
    expect(fs.readdirSync(dir)).toEqual(['s2']);
    st.id = 's3';
    m.check();
    expect(fs.readdirSync(dir)).toEqual(['s3']);
  });

  it('an id that is not a plain id is never a file name', () => {
    const { m, st } = make('../x');
    st.working = true;
    m.check();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(m.take('../x')).toBe(false);
  });
});

describe('changesWork: only events that can start or end the work wake the check (streaming does not)', () => {
  it('turn, task, permission and session events do; text, tools and state frames do not', () => {
    const yes = [
      { kind: 'user', id: 'u', text: 'x', ts: 1 }, { kind: 'agent', e: { t: 'turn-start' }, ts: 1 },
      { kind: 'agent', e: { t: 'turn-end', stop: 'done', secs: 1, answers: 'all', queued: 0 }, ts: 1 },
      { kind: 'agent', e: { t: 'task', id: 't', phase: 'done' }, ts: 1 }, { kind: 'agent', e: { t: 'cancelled', sendId: 'u' }, ts: 1 },
      { kind: 'permission', id: 'p', toolName: 'Bash', input: {}, ts: 1 }, { kind: 'permission-done', id: 'p', allow: true, ts: 1 },
      { kind: 'session', id: 's', root: '/r', title: null, model: null },
    ];
    const no = [
      { kind: 'agent', e: { t: 'message-chunk', text: 'x' }, ts: 1 }, { kind: 'agent', e: { t: 'message', id: 'm', text: 'x' }, ts: 1 },
      { kind: 'agent', e: { t: 'tool-call', id: 't', name: 'Read', input: {}, sub: false }, ts: 1 },
      { kind: 'stats', stats: {} }, { kind: 'shell-out', id: 'x', text: '', truncated: false },
    ];
    expect(yes.map((e) => changesWork(e as never))).toEqual(yes.map(() => true));
    expect(no.map((e) => changesWork(e as never))).toEqual(no.map(() => false));
  });
});
