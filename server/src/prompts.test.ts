import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PromptEntry } from '@nota-bene/shared';
import { EventHub } from './hub.ts';
import { PromptStore, promptRoutes } from './prompts.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-prompts-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const p = (id: string, text = `t-${id}`, extra: Partial<PromptEntry> = {}): PromptEntry => ({ id, ts: 1, text, src: 'typed', ...extra });

describe('PromptStore', () => {
  it('append then list round-trips and persists to <dir>/<id>.jsonl, one line per prompt', () => {
    const s = new PromptStore({ dir });
    s.append('sess-1', p('a'));
    s.append('sess-1', p('b', 'two\nlines'));
    expect(s.list('sess-1')).toEqual([p('a'), p('b', 'two\nlines')]);
    expect(fs.readFileSync(path.join(dir, 'sess-1.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    expect(new PromptStore({ dir }).list('sess-1')).toHaveLength(2);
  });
  it('forget removes the file and the cached list; a missing one is fine, a bad id is refused', () => {
    const s = new PromptStore({ dir });
    s.append('sess-1', p('a'));
    s.forget('sess-1');
    expect(fs.existsSync(path.join(dir, 'sess-1.jsonl'))).toBe(false);
    expect(s.list('sess-1')).toEqual([]);
    s.forget('sess-1');
    expect(() => s.forget('../x')).toThrow();
  });

  it('the same id again is ignored', () => {
    const s = new PromptStore({ dir });
    s.append('s', p('a'));
    s.append('s', p('a', 'changed'));
    s.append(null, p('m'));
    s.append(null, p('m', 'changed'));
    expect(s.list('s').map((x) => x.text)).toEqual(['t-a']);
    expect(s.list(null).map((x) => x.text)).toEqual(['t-m']);
  });
  it('a corrupt line is skipped and reported once', () => {
    fs.writeFileSync(path.join(dir, 's.jsonl'), `${JSON.stringify(p('a'))}\nnot json\n{"v":1,"id":5}\n${JSON.stringify(p('b'))}\n`);
    const seen: Error[] = [];
    const s = new PromptStore({ dir, report: (e) => seen.push(e) });
    expect(s.list('s').map((x) => x.id)).toEqual(['a', 'b']);
    s.list('s');
    expect(seen).toHaveLength(1);
  });
  it('list returns the last 1000', () => {
    const s = new PromptStore({ dir });
    for (let i = 0; i < 1005; i++) s.append('s', p(`id-${i}`));
    const out = s.list('s');
    expect(out).toHaveLength(1000);
    expect(out[0]!.id).toBe('id-5');
  });
  it('the unidentified session stays in memory; adopt writes it under the id', () => {
    const s = new PromptStore({ dir });
    s.append(null, p('a'));
    expect(fs.readdirSync(dir)).toEqual([]);
    s.adopt('sess-2');
    expect(s.list(null)).toEqual([]);
    expect(s.list('sess-2')).toEqual([p('a')]);
  });
  it('adopt merges with a stored file without duplicating ids', () => {
    const s = new PromptStore({ dir });
    s.append('sess', p('a'));
    s.append(null, p('a'));
    s.append(null, p('b'));
    s.adopt('sess');
    expect(s.list('sess').map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('dropPending forgets the in-memory ones', () => {
    const s = new PromptStore({ dir });
    s.append(null, p('a'));
    s.dropPending();
    expect(s.list(null)).toEqual([]);
  });
  it('carry copies one session\'s file to another that has none, never over an existing one', () => {
    const s = new PromptStore({ dir });
    s.append('old', p('a'));
    s.carry('old', 'new');
    expect(s.list('new')).toEqual([p('a')]);
    s.append('old', p('b'));
    s.carry('old', 'new');
    expect(s.list('new')).toEqual([p('a')]);
    s.carry('missing', 'other');
    expect(fs.existsSync(path.join(dir, 'other.jsonl'))).toBe(false);
  });
  it('reads a file once: later lists and appends work from memory', () => {
    const s = new PromptStore({ dir });
    s.append('s', p('a'));
    fs.writeFileSync(path.join(dir, 's.jsonl'), 'garbage\n'); // changed behind its back: not looked at again
    expect(s.list('s').map((x) => x.id)).toEqual(['a']);
    s.append('s', p('b'));
    expect(s.list('s').map((x) => x.id)).toEqual(['a', 'b']);
    s.append('s', p('a', 'dup'));
    expect(s.list('s')).toHaveLength(2);
  });
  it('carry makes the target\'s cached list stale-free', () => {
    const s = new PromptStore({ dir });
    s.append('old', p('a'));
    expect(s.list('new')).toEqual([]);
    s.carry('old', 'new');
    expect(s.list('new').map((x) => x.id)).toEqual(['a']);
  });
  it('refuses an unsafe session id', () => {
    expect(() => new PromptStore({ dir }).append('../x', p('a'))).toThrow();
  });
});

describe('promptRoutes', () => {
  let current: string | null;
  let own: string | null; // the conversation's own id: null while a fork or an id-less /clear has none yet
  let srv: http.Server;
  let base: string;
  let store: PromptStore;
  beforeEach(async () => {
    current = own = 'cur';
    store = new PromptStore({ dir });
    const routes = promptRoutes({ store, current: () => current, own: () => own, hub: new EventHub() });
    srv = http.createServer((req, res) => {
      const route = routes[new URL(req.url ?? '/', 'http://x').pathname];
      if (route) route(req, res); else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise((r) => srv.close(r)); });
  const post = (body: unknown) => fetch(`${base}/prompts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('POST writes under the session; GET answers the current conversation\'s', async () => {
    expect((await post({ session: 'cur', id: 'a', text: 'hello', src: 'typed' })).status).toBe(204);
    const res = await fetch(`${base}/prompts?session=cur`);
    expect(res.status).toBe(200);
    const body = await res.json() as { session: string | null; prompts: PromptEntry[] };
    expect(body.session).toBe('cur');
    expect(body.prompts).toMatchObject([{ id: 'a', text: 'hello', src: 'typed' }]);
    expect(typeof body.prompts[0]!.ts).toBe('number');
  });
  it('GET of another session is 409; a bad session is 400', async () => {
    expect((await fetch(`${base}/prompts?session=other`)).status).toBe(409);
    expect((await fetch(`${base}/prompts?session=../x`)).status).toBe(400);
  });
  it('GET without a session answers the current one (and the in-memory ones while it has no id)', async () => {
    current = own = null;
    expect((await post({ session: null, id: 'm', text: 'first', src: 'typed' })).status).toBe(204);
    const body = await (await fetch(`${base}/prompts`)).json() as { session: string | null; prompts: PromptEntry[] };
    expect(body.session).toBeNull();
    expect(body.prompts.map((x) => x.id)).toEqual(['m']);
  });
  it('POST with a null session goes to the current id when it has one', async () => {
    expect((await post({ session: null, id: 'a', text: 'x', src: 'shell' })).status).toBe(204);
    expect(store.list('cur').map((x) => x.id)).toEqual(['a']);
  });
  it('while the conversation has no id of its own (a fork), a POST for the source id waits in memory, and GET shows the source\'s plus those', async () => {
    store.append('cur', p('old'));
    own = null;
    expect((await post({ session: 'cur', id: 'new', text: 'x', src: 'typed' })).status).toBe(204);
    expect(store.list('cur').map((x) => x.id)).toEqual(['old']);
    const body = await (await fetch(`${base}/prompts?session=cur`)).json() as { session: string; prompts: PromptEntry[] };
    expect(body.prompts.map((x) => x.id)).toEqual(['old', 'new']);
    expect(store.list(null).map((x) => x.id)).toEqual(['new']);
    // a null session is the same pending list
    expect((await post({ session: null, id: 'n2', text: 'y', src: 'typed' })).status).toBe(204);
    expect(store.list(null).map((x) => x.id)).toEqual(['new', 'n2']);
  });
  it('POST for another valid id is written there (a switch in flight)', async () => {
    expect((await post({ session: 'elsewhere', id: 'a', text: 'x', src: 'voice' })).status).toBe(204);
    expect(store.list('elsewhere')).toHaveLength(1);
  });
  it('POST: bad body, empty or oversized text, bad src, bad id are 400', async () => {
    for (const body of [
      { session: 'cur', id: 'a', text: '', src: 'typed' },
      { session: 'cur', id: 'a', text: 'x'.repeat(32001), src: 'typed' },
      { session: 'cur', id: 'a', text: 'x', src: 'other' },
      { session: 'cur', id: '', text: 'x', src: 'typed' },
      { session: '../x', id: 'a', text: 'x', src: 'typed' },
      { session: 'cur', id: 'a', text: 5, src: 'typed' },
      'nonsense',
    ]) expect((await post(body)).status).toBe(400);
    const raw = await fetch(`${base}/prompts`, { method: 'POST', body: '{not json' });
    expect(raw.status).toBe(400);
    expect(store.list('cur')).toEqual([]);
  });
  it('another method is 405', async () => {
    expect((await fetch(`${base}/prompts`, { method: 'DELETE' })).status).toBe(405);
  });
});
