import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Comment, CommentOp } from '@nota-bene/shared';
import { CommentStore, TOMBSTONES } from './comments.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-comments-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const c = (id: string): Comment => ({
  id, text: `t-${id}`, status: 'pending', createdAt: 1,
  anchor: { source: { kind: 'message', id: 'm1' }, quote: 'q', start: 0, end: 1 },
} as unknown as Comment);

describe('CommentStore', () => {
  it('set then get round-trips and persists to <dir>/<id>.v2.json with its revision', () => {
    const s = new CommentStore({ dir });
    s.set('abc-1', [c('a')]);
    expect(s.get('abc-1')).toEqual([c('a')]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'abc-1.v2.json'), 'utf8'))).toEqual({ v: 2, rev: expect.any(Number), items: [c('a')], removed: [] });
    expect(new CommentStore({ dir }).get('abc-1')).toEqual([c('a')]);
    expect(fs.readdirSync(dir)).toEqual(['abc-1.v2.json']);
  });
  it('get returns a copy', () => {
    const s = new CommentStore({ dir });
    s.set('abc', [c('a')]);
    s.get('abc').push(c('b'));
    expect(s.get('abc')).toHaveLength(1);
    s.get(null).push(c('b'));
    expect(s.get(null)).toHaveLength(0);
  });
  it('null session stays in memory and writes no file', () => {
    const s = new CommentStore({ dir });
    s.set(null, [c('a')]);
    expect(s.get(null)).toEqual([c('a')]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it('adopt moves the in-memory set under the id', () => {
    const s = new CommentStore({ dir });
    s.set(null, [c('a')]);
    s.adopt('sess-2');
    expect(s.get(null)).toEqual([]);
    expect(s.get('sess-2')).toEqual([c('a')]);
    expect(fs.existsSync(path.join(dir, 'sess-2.v2.json'))).toBe(true);
  });
  it('adopt merges by id, stored entries first, no duplicates', () => {
    const s = new CommentStore({ dir });
    s.set('sess', [{ ...c('a'), text: 'stored' }]);
    s.set(null, [{ ...c('a'), text: 'mem' }, c('b')]);
    s.adopt('sess');
    expect(s.get('sess').map((x) => [x.id, x.text])).toEqual([['a', 'stored'], ['b', 't-b']]);
  });
  it('adopt prefers the sent copy over a stored pending one', () => {
    const s = new CommentStore({ dir });
    s.set('sess', [c('a'), { ...c('b'), status: 'sent', sentIn: 'u0' }]);
    s.set(null, [{ ...c('a'), status: 'sent', sentIn: 'u1' }, c('b')]);
    s.adopt('sess');
    expect(s.get('sess').map((x) => [x.id, x.status, x.sentIn])).toEqual([['a', 'sent', 'u1'], ['b', 'sent', 'u0']]);
  });
  it('merge keeps stored sent comments: a pending copy stays sent, a missing one is re-appended', () => {
    const s = new CommentStore({ dir });
    const sent = (id: string): Comment => ({ ...c(id), status: 'sent', sentIn: 'u1' });
    s.set('m', [sent('a'), sent('b'), c('p')]);
    const out = s.merge('m', [{ ...c('a'), text: 'stale' }, c('p'), c('n')]);
    expect(out.map((x) => [x.id, x.status])).toEqual([['a', 'sent'], ['p', 'pending'], ['n', 'pending'], ['b', 'sent']]);
    expect(out[0]).toEqual(sent('a'));
    expect(s.get('m')).toEqual(out);
    // the in-memory (pre-init) set follows the same rule
    s.set(null, [sent('x')]);
    expect(s.merge(null, [c('x')])).toEqual([sent('x')]);
  });
  it('a non-ENOENT read error is rethrown, not read as []', () => {
    fs.mkdirSync(path.join(dir, 'dirasfile.json'));
    expect(() => new CommentStore({ dir }).get('dirasfile')).toThrow();
  });
  it('drops stored elements without a string id', () => {
    fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify([1, null, { id: 5 }, c('a')]));
    expect(new CommentStore({ dir }).get('x')).toEqual([c('a')]);
  });
  it('markSent sets status and sentIn only for the given ids', () => {
    const s = new CommentStore({ dir });
    s.set('s', [c('a'), c('b')]);
    const out = s.markSent('s', ['a'], 'msg-1');
    expect(out.find((x) => x.id === 'a')).toMatchObject({ status: 'sent', sentIn: 'msg-1' });
    expect(out.find((x) => x.id === 'b')).toMatchObject({ status: 'pending' });
    expect(out.find((x) => x.id === 'b')?.sentIn).toBeUndefined();
    expect(new CommentStore({ dir }).get('s')).toEqual(out);
  });
  it('markPending gives back the comments sent in that message only', () => {
    const s = new CommentStore({ dir });
    s.set('s', [c('a'), c('b'), c('d')]);
    s.markSent('s', ['a', 'b'], 'msg-1');
    s.markSent('s', ['d'], 'msg-2');
    const out = s.markPending('s', 'msg-1');
    expect(out.find((x) => x.id === 'a')).toMatchObject({ status: 'pending' });
    expect(out.find((x) => x.id === 'a')?.sentIn).toBeUndefined();
    expect(out.find((x) => x.id === 'd')).toMatchObject({ status: 'sent', sentIn: 'msg-2' });
    expect(new CommentStore({ dir }).get('s')).toEqual(out);
  });
  it('a corrupt or non-array file reads as []', () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{');
    fs.writeFileSync(path.join(dir, 'obj.json'), '{"a":1}');
    const s = new CommentStore({ dir });
    expect(s.get('bad')).toEqual([]);
    expect(s.get('obj')).toEqual([]);
  });
  it('rejects session ids that are not safe file names', () => {
    const s = new CommentStore({ dir });
    for (const id of ['../x', 'a/b', '', 'a.b', 'x'.repeat(101)]) {
      expect(() => s.get(id)).toThrow();
      expect(() => s.set(id, [])).toThrow();
    }
    expect(() => s.set('fake-session', [])).not.toThrow();
  });
});

describe('CommentStore: ops and revisions (protocol 19)', () => {
  const add = (x: Comment): CommentOp => ({ op: 'add', comment: x });
  const sent = (id: string): Comment => ({ ...c(id), status: 'sent', sentIn: 'u1' });

  it('a legacy array reads as revision 0; the first change goes to the v2 file and leaves the legacy one as it was', () => {
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify([c('a')]));
    const s = new CommentStore({ dir });
    expect(s.state('old')).toEqual({ rev: 0, items: [c('a')], removed: [] });
    expect(s.apply('old', [add(c('b'))])).toBeNull();
    expect(s.get('old')).toEqual([c('a'), c('b')]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'old.json'), 'utf8'))).toEqual([c('a')]);
    expect(s.state('old').rev).toBeGreaterThan(0);
  });

  it('every change raises the revision, also across a new store', () => {
    const s = new CommentStore({ dir });
    s.set('r', [c('a')]);
    const r1 = s.state('r').rev;
    s.apply('r', [{ op: 'remove', id: 'a' }]);
    const r2 = new CommentStore({ dir }).state('r').rev;
    expect(r2).toBeGreaterThan(r1);
    s.set(null, [c('x')]);
    const n1 = s.state(null).rev;
    s.dropPending();
    expect(s.state(null).rev).toBeGreaterThan(n1);
  });

  it('add: a resent add changes nothing; a new comment is pending whatever the client says', () => {
    const s = new CommentStore({ dir });
    expect(s.apply('k', [add(sent('a'))])).toBeNull();
    expect(s.get('k')).toEqual([c('a')]);
    const rev = s.state('k').rev;
    expect(s.apply('k', [add({ ...c('a'), text: 'other' })])).toBeNull();
    expect(s.get('k')).toEqual([c('a')]);
    expect(s.state('k').rev).toBeGreaterThanOrEqual(rev);
  });

  it('remove leaves the id deleted: an add cannot bring it back, a second remove is a no-op', () => {
    const s = new CommentStore({ dir });
    s.set('k', [c('a'), c('b')]);
    expect(s.apply('k', [{ op: 'remove', id: 'a' }])).toBeNull();
    expect(s.apply('k', [{ op: 'remove', id: 'a' }])).toBeNull();
    expect(s.get('k')).toEqual([c('b')]);
    expect(s.apply('k', [add(c('a'))])).toEqual({ reason: 'gone', id: 'a' });
    // a remove of an id the server never had still blocks a later add of it (the client deleted it offline)
    expect(s.apply('k', [{ op: 'remove', id: 'z' }])).toBeNull();
    expect(s.apply('k', [add(c('z'))])).toEqual({ reason: 'gone', id: 'z' });
    expect(s.get('k')).toEqual([c('b')]);
  });

  it('edit replaces the editable fields and keeps the anchor, time and status; a missing or sent comment refuses', () => {
    const s = new CommentStore({ dir });
    s.set('k', [{ ...c('a'), label: 'clarify', images: ['i1'] }, sent('s')]);
    const edited = { ...c('a'), text: 'new', createdAt: 99, anchor: { ...c('a').anchor, quote: 'moved' }, genImages: 1 } as Comment;
    expect(s.apply('k', [{ op: 'edit', comment: edited }])).toBeNull();
    // label and images left out of the edit are cleared; anchor and createdAt stay the server's
    expect(s.get('k')[0]).toEqual({ ...c('a'), text: 'new', genImages: 1 });
    expect(s.apply('k', [{ op: 'edit', comment: c('nope') }])).toEqual({ reason: 'gone', id: 'nope' });
    expect(s.apply('k', [{ op: 'edit', comment: c('s') }])).toEqual({ reason: 'sent', id: 's' });
    expect(s.apply('k', [{ op: 'remove', id: 's' }])).toEqual({ reason: 'sent', id: 's' });
    expect(s.get('k')[1]).toEqual(sent('s'));
  });

  it('a refused batch stores nothing of it', () => {
    const s = new CommentStore({ dir });
    s.set('k', [sent('s')]);
    const before = s.state('k');
    expect(s.apply('k', [add(c('a')), { op: 'remove', id: 's' }])).toEqual({ reason: 'sent', id: 's' });
    expect(s.state('k')).toEqual(before);
  });

  it('a whole set (before protocol 19) cannot bring back a deleted id, and what it leaves out counts as deleted', () => {
    const s = new CommentStore({ dir });
    s.set('k', [c('a'), c('b')]);
    s.apply('k', [{ op: 'remove', id: 'a' }]);
    expect(s.merge('k', [c('a'), c('b')])).toEqual([c('b')]);
    s.merge('k', []);
    expect(s.apply('k', [add(c('b'))])).toEqual({ reason: 'gone', id: 'b' });
  });

  it('the null session keeps its deleted ids through adopt, and drops them with its set', () => {
    const s = new CommentStore({ dir });
    s.apply(null, [add(c('a')), { op: 'remove', id: 'a' }]);
    s.adopt('k');
    expect(s.apply('k', [add(c('a'))])).toEqual({ reason: 'gone', id: 'a' });
    s.apply(null, [{ op: 'remove', id: 'q' }]);
    s.dropPending();
    expect(s.apply(null, [add(c('q'))])).toBeNull();
  });

  it(`keeps the last ${TOMBSTONES} deleted ids`, () => {
    const s = new CommentStore({ dir });
    s.apply('k', Array.from({ length: 50 }, (_, i) => ({ op: 'remove' as const, id: `old-${i}` })));
    for (let n = 0; n < TOMBSTONES / 50; n++) s.apply('k', Array.from({ length: 50 }, (_, i) => ({ op: 'remove' as const, id: `x-${n}-${i}` })));
    const { removed } = s.state('k');
    expect(removed).toHaveLength(TOMBSTONES);
    expect(removed).not.toContain('old-0');
    expect(s.apply('k', [add(c('old-0'))])).toBeNull();
  });
});
