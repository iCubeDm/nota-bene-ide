import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, Comment, ServerEvent } from '@nota-bene/shared';
import { makeStore, sendMessage } from '../store/store.ts';
import {
  addComment, closeCommentCard, editComment, openCommentCard, removeComment, selectComments, selectCommentsUi,
  selectPending, selectSentFor, setPanelOpen,
} from './slice.ts';

function fake(ok = true) {
  const sent: ClientMessage[] = [];
  let onEvent!: (e: ServerEvent) => void;
  let onState!: (s: 'open' | 'closed') => void;
  let open = ok;
  const connect = vi.fn((_u: unknown, e: typeof onEvent, s: typeof onState) => {
    onEvent = e;
    onState = s;
    return { send: (m: ClientMessage) => (open && sent.push(m), open), close() {} };
  });
  return { sent, connect, ev: (e: ServerEvent) => onEvent(e), state: (s: 'open' | 'closed') => onState(s), setOpen: (v: boolean) => (open = v) };
}

const anchor = { source: { kind: 'message' as const, id: 'm1' }, start: 0, end: 3, quote: 'abc', prefix: '', suffix: '' };
const draft = { anchor, text: 'note' };
const mk = (id: string, over: Partial<Comment> = {}): Comment => ({ id, anchor, text: id, status: 'pending', createdAt: 1, ...over });

beforeEach(() => localStorage.clear());

it('add sends the full set', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  f.state('open');
  store.dispatch(addComment(draft));
  store.dispatch(addComment({ ...draft, text: 'two' }));
  const [c] = selectComments(store.getState());
  expect(c).toMatchObject({ text: 'note', status: 'pending' });
  expect(Number.isInteger(c!.createdAt)).toBe(true);
  expect(c!.id).toBeTruthy();
  const last = f.sent[f.sent.length - 1] as { type: 'comments'; items: Comment[] };
  expect(last.type).toBe('comments');
  expect(last.items).toHaveLength(2);
});

it('server echo replaces local items, replay does not clear them', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  store.dispatch(addComment(draft));
  f.ev({ kind: 'replay', events: [] });
  expect(selectComments(store.getState())).toHaveLength(1);
  f.ev({ kind: 'comments', items: [mk('s1', { status: 'sent', sentIn: 'u1' })] });
  expect(selectComments(store.getState()).map((c) => c.id)).toEqual(['s1']);
});

it('local change survives a closed socket and rides the next sync', () => {
  const f = fake(false);
  const store = makeStore({ url: 'u', connect: f.connect });
  store.dispatch(addComment(draft));
  expect(selectComments(store.getState())).toHaveLength(1);
  expect(f.sent).toEqual([]);
  f.setOpen(true);
  store.dispatch(addComment({ ...draft, text: 'two' }));
  expect((f.sent[0] as { items: Comment[] }).items).toHaveLength(2);
});

it('edit and remove', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  f.ev({ kind: 'comments', items: [mk('a'), mk('b')] });
  store.dispatch(editComment('a', 'new'));
  expect(selectComments(store.getState())[0]!.text).toBe('new');
  expect((f.sent.at(-1) as { items: Comment[] }).items[0]!.text).toBe('new');
  store.dispatch(removeComment('a'));
  expect(selectComments(store.getState()).map((c) => c.id)).toEqual(['b']);
  expect((f.sent.at(-1) as { items: Comment[] }).items.map((c) => c.id)).toEqual(['b']);
});

it('selectSentFor groups by sentIn', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  f.ev({ kind: 'comments', items: [mk('a'), mk('b', { status: 'sent', sentIn: 'u1' }), mk('c', { status: 'sent', sentIn: 'u2' })] });
  expect(selectPending(store.getState()).map((c) => c.id)).toEqual(['a']);
  expect(selectSentFor(store.getState(), 'u1').map((c) => c.id)).toEqual(['b']);
  expect(selectSentFor(store.getState(), 'zz')).toEqual([]);
});

it('ui state: panel and card', () => {
  const f = fake();
  localStorage.removeItem('panel:comments');
  const store = makeStore({ url: 'u', connect: f.connect });
  expect(selectCommentsUi(store.getState())).toEqual({ panelOpen: true, card: null }); // open by default (R-M6-3)
  store.dispatch(setPanelOpen(false));
  expect(selectCommentsUi(store.getState()).panelOpen).toBe(false);
  store.dispatch(setPanelOpen(true));
  store.dispatch(openCommentCard({ id: 'a', x: 1, y: 2 }));
  expect(selectCommentsUi(store.getState())).toEqual({ panelOpen: true, card: { id: 'a', x: 1, y: 2 } });
  store.dispatch(closeCommentCard());
  expect(selectCommentsUi(store.getState()).card).toBeNull();
});

it('panelOpen initial reads localStorage', () => {
  localStorage.setItem('panel:comments', '1');
  const store = makeStore({ url: 'u', connect: fake().connect });
  expect(selectCommentsUi(store.getState()).panelOpen).toBe(true);
});

it('sendMessage carries commentIds only when non-empty, and does not mark sent locally', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  f.state('open');
  f.ev({ kind: 'comments', items: [mk('a')] });
  store.dispatch(sendMessage('hi', false));
  expect(f.sent[0]).not.toHaveProperty('commentIds');
  store.dispatch(sendMessage('hi', false, []));
  expect(f.sent[1]).not.toHaveProperty('commentIds');
  store.dispatch(sendMessage('hi', false, ['a']));
  expect(f.sent[2]).toMatchObject({ commentIds: ['a'] });
  expect(selectPending(store.getState())).toHaveLength(1);
});

it('selectors are referentially stable', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  f.ev({ kind: 'comments', items: [mk('a'), mk('b', { status: 'sent', sentIn: 'u1' })] });
  const s = store.getState();
  expect(selectPending(s)).toBe(selectPending(store.getState()));
  expect(selectSentFor(s, 'u1')).toBe(selectSentFor(store.getState(), 'u1'));
  expect(selectSentFor(s, 'none')).toBe(selectSentFor(s, 'other'));
});

it('offline edit survives a server push and is re-sent on open', () => {
  const f = fake(false);
  const store = makeStore({ url: 'u', connect: f.connect });
  f.ev({ kind: 'comments', items: [mk('a')] });
  store.dispatch(editComment('a', 'offline'));
  f.ev({ kind: 'comments', items: [mk('a')] });
  expect(selectComments(store.getState())[0]!.text).toBe('offline');
  f.setOpen(true);
  f.state('open');
  expect(f.sent).toHaveLength(1);
  expect((f.sent[0] as { items: Comment[] }).items[0]!.text).toBe('offline');
  f.state('open');
  expect(f.sent).toHaveLength(1);
  f.ev({ kind: 'comments', items: [mk('a')] }); // stale initial push, skipped
  expect(selectComments(store.getState())[0]!.text).toBe('offline');
  f.ev({ kind: 'comments', items: [mk('a', { text: 'srv' })] });
  expect(selectComments(store.getState())[0]!.text).toBe('srv');
});

it('stale server push after the re-send is skipped once; a following edit keeps the offline change', () => {
  const f = fake(false);
  const store = makeStore({ url: 'u', connect: f.connect });
  f.ev({ kind: 'comments', items: [mk('a'), mk('b')] });
  store.dispatch(editComment('a', 'offline'));
  f.setOpen(true);
  f.state('open');
  f.ev({ kind: 'comments', items: [mk('a'), mk('b')] }); // stale initial push
  expect(selectComments(store.getState())[0]!.text).toBe('offline');
  store.dispatch(editComment('b', 'later'));
  const last = f.sent.at(-1) as { items: Comment[] };
  expect(last.items.map((c) => c.text)).toEqual(['offline', 'later']);
  f.ev({ kind: 'comments', items: [mk('z')] });
  expect(selectComments(store.getState()).map((c) => c.id)).toEqual(['z']);
});

it('a socket that closes before the stale push arrives keeps the change unsynced and re-sends it on the next open', () => {
  const f = fake(false);
  const store = makeStore({ url: 'u', connect: f.connect });
  f.ev({ kind: 'comments', items: [mk('a')] });
  store.dispatch(editComment('a', 'offline'));
  f.setOpen(true);
  f.state('open');
  expect(f.sent).toHaveLength(1);
  f.setOpen(false);
  f.state('closed'); // the re-send may never have arrived
  expect(store.getState().comments).toMatchObject({ resent: false, unsynced: true });
  f.ev({ kind: 'comments', items: [mk('a')] }); // a push while unsynced does not win
  expect(selectComments(store.getState())[0]!.text).toBe('offline');
  f.setOpen(true);
  f.state('open');
  expect(f.sent).toHaveLength(2);
  expect((f.sent[1] as { items: Comment[] }).items[0]!.text).toBe('offline');
});

it('add keeps a caller-given id (a media comment: its mark folder is named by it)', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  f.state('open');
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  store.dispatch(addComment({ ...draft, id }));
  expect(selectComments(store.getState())[0]).toMatchObject({ id, status: 'pending', text: 'note' });
});

describe('comment ops (protocol 19)', () => {
  const hello = (protocol = 19) => ({ kind: 'hello', protocol } as ServerEvent);
  const set = (items: Comment[], ack?: string[]): ServerEvent => ({ kind: 'comments', items, rev: 1, ...(ack ? { ack } : {}) });
  const ops = (f: ReturnType<typeof fake>) => f.sent.filter((m): m is Extract<ClientMessage, { type: 'comment-op' }> => m.type === 'comment-op');
  function boot(initial: Comment[] = []) {
    const f = fake();
    const store = makeStore({ url: 'u', connect: f.connect });
    f.state('open');
    f.ev(set(initial)); // the set comes before hello
    f.ev(hello());
    return { f, store };
  }

  it('the set that came before hello is kept; a change goes as one op, shown before the server answers', () => {
    const { f, store } = boot([mk('a')]);
    expect(selectComments(store.getState()).map((c) => c.id)).toEqual(['a']);
    store.dispatch(addComment({ ...draft, id: 'b' }));
    expect(selectComments(store.getState()).map((c) => c.id)).toEqual(['a', 'b']);
    expect(f.sent.some((m) => m.type === 'comments')).toBe(false);
    expect(ops(f)).toHaveLength(1);
    expect(ops(f)[0]).toMatchObject({ sessionId: null, ops: [{ op: 'add', comment: { id: 'b', text: 'note', status: 'pending' } }] });
  });

  it('every queued op goes at once, in order and once per socket; a message sent after them follows them on the wire', () => {
    const { f, store } = boot();
    store.dispatch(addComment({ ...draft, id: 'a' }));
    store.dispatch(addComment({ ...draft, id: 'b' }));
    expect(ops(f).map((o) => o.ops[0]).map((o) => (o!.op === 'add' ? o!.comment.id : ''))).toEqual(['a', 'b']);
    f.ev(set([mk('a')], [ops(f)[0]!.opId]));
    expect(ops(f)).toHaveLength(2);
    expect(selectComments(store.getState()).map((c) => c.id)).toEqual(['a', 'b']);
    store.dispatch(sendMessage('go', false, ['a', 'b']));
    expect(f.sent.map((m) => m.type)).toEqual(['comment-op', 'comment-op', 'send']);
  });

  it('issue 259: a set from the server that lacks a queued comment does not hide it, and a deleted one does not come back', () => {
    const { f, store } = boot([mk('old')]);
    f.setOpen(false);
    f.state('closed');
    store.dispatch(addComment({ ...draft, id: 'new' }));
    store.dispatch(removeComment('old'));
    // back online: the server's set still has `old` and not `new`
    f.setOpen(true);
    f.state('open');
    f.ev(set([mk('old')]));
    f.ev(hello());
    expect(selectComments(store.getState()).map((c) => c.id)).toEqual(['new']);
    expect(ops(f).map((o) => o.ops[0]!.op)).toEqual(['add', 'remove']);
    // the server's answer to the add alone: the remove is still queued, so `old` stays hidden
    f.ev(set([mk('old'), mk('new', { text: 'note' })], [ops(f)[0]!.opId]));
    expect(selectComments(store.getState()).map((c) => c.id)).toEqual(['new']);
    expect(ops(f)).toHaveLength(2);
  });

  it('an op on the wire when the socket drops is sent again on the next open', () => {
    const { f, store } = boot();
    store.dispatch(addComment({ ...draft, id: 'a' }));
    const first = ops(f)[0]!.opId;
    f.state('closed');
    f.state('open');
    expect(ops(f).map((o) => o.opId)).toEqual([first, first]);
  });

  it('edit sends the comment as edited; a refusal by another window drops the change and says so', async () => {
    const { toast: spy } = await import('../shell/toast.ts').then((m) => ({ toast: vi.spyOn(m, 'toast') }));
    const { f, store } = boot([mk('a', { label: 'fire' })]);
    store.dispatch(editComment('a', 'better'));
    expect(ops(f)[0]!.ops[0]).toEqual({ op: 'edit', comment: { ...mk('a', { label: 'fire' }), text: 'better' } });
    expect(selectComments(store.getState())[0]!.text).toBe('better');
    f.ev({ kind: 'comment-refused', opId: ops(f)[0]!.opId, reason: 'gone', id: 'a' });
    expect(selectComments(store.getState())[0]!.text).toBe('a');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('a failed store keeps the change queued and sends it again, without a toast', () => {
    const { f, store } = boot();
    store.dispatch(addComment({ ...draft, id: 'a' }));
    const id = ops(f)[0]!.opId;
    f.ev({ kind: 'comment-refused', opId: id, reason: 'failed' });
    expect(selectComments(store.getState()).map((c) => c.id)).toEqual(['a']);
    expect(ops(f).map((o) => o.opId)).toEqual([id, id]);
  });

  it('an op of another session is not shown here; its comment-ack takes it off the queue', () => {
    const { f, store } = boot();
    f.ev({ kind: 'session', id: 's1', root: '/p', title: null, model: null });
    f.setOpen(false);
    f.state('closed');
    store.dispatch(addComment({ ...draft, id: 'a' }));
    f.setOpen(true);
    f.state('open');
    f.ev({ kind: 'session', id: 's2', root: '/p', title: null, model: null });
    f.ev(set([]));
    f.ev(hello());
    expect(selectComments(store.getState())).toEqual([]);
    expect(ops(f)[0]).toMatchObject({ sessionId: 's1' });
    f.ev({ kind: 'comment-ack', opId: ops(f)[0]!.opId });
    store.dispatch(removeComment('zzz'));
    expect(ops(f)).toHaveLength(2);
  });

  it('a server older than 19 after all: what is queued goes as the whole set', () => {
    const { f, store } = boot([mk('a')]);
    f.setOpen(false);
    f.state('closed');
    store.dispatch(addComment({ ...draft, id: 'b' }));
    f.setOpen(true);
    f.state('open');
    f.ev(set([mk('a')]));
    f.ev(hello(18));
    const whole = f.sent.filter((m): m is Extract<ClientMessage, { type: 'comments' }> => m.type === 'comments');
    expect(whole.at(-1)!.items.map((c) => c.id)).toEqual(['a', 'b']);
    expect(selectComments(store.getState()).map((c) => c.id)).toEqual(['a', 'b']);
  });
});
