import { afterEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { fragmentSession } from '@/core/net/auth.ts';
import { t } from '@/core/i18n/index.ts';
import { getToasts } from '@/core/shell/toast.ts';
import { makeStore } from '@/core/testing';
import { startLanding } from './landing.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'a'.repeat(64);

function rig() {
  const sent: ClientMessage[] = [];
  let ev!: (e: ServerEvent) => void;
  let st!: (s: never) => void;
  const store = makeStore({ url: 'ws://x', connect: (_u, onEvent, onState) => { ev = onEvent; st = onState as never; return { send: (m: ClientMessage) => { sent.push(m); return true; }, close() {} }; } });
  const open = () => st('open' as never);
  const session = (id: string | null) => ev({ kind: 'session', id, root: '/r', title: null, model: null } as ServerEvent);
  return { store, sent, open, session };
}
afterEach(() => vi.restoreAllMocks());

it('the fragment may carry a session after the login; anything else after it is no session', () => {
  expect(fragmentSession(`#t=${TOKEN}&s=${A}`)).toBe(A);
  expect(fragmentSession(`#t=${TOKEN}&s=new`)).toBe('new');
  expect(fragmentSession(`#t=${TOKEN}`)).toBeNull();
  expect(fragmentSession(`#t=${TOKEN}&s=../x`)).toBeNull();
  expect(fragmentSession(`#s=${A}`)).toBeNull();
});

it('once the window tells its session, a different one is switched to, once', () => {
  const r = rig();
  startLanding(r.store, B);
  r.open();
  r.session(A);
  expect(r.sent.filter((m) => m.type === 'switch')).toEqual([{ type: 'switch', id: B, dir: '/r' }]);
  r.session(A);
  expect(r.sent.filter((m) => m.type === 'switch')).toHaveLength(1);
});

it('new starts a new session in the window\'s folder', () => {
  const r = rig();
  startLanding(r.store, 'new');
  r.open();
  r.session(A);
  expect(r.sent.filter((m) => m.type === 'switch')).toEqual([{ type: 'switch', id: null, dir: '/r' }]);
});

it('the session already open is left as it is', () => {
  const r = rig();
  startLanding(r.store, A);
  r.open();
  r.session(A);
  expect(r.sent.some((m) => m.type === 'switch')).toBe(false);
});

it('a refused switch says so', () => {
  const r = rig();
  startLanding(r.store, B, () => 'busy');
  r.open();
  r.session(A);
  expect(getToasts().some((x) => x.title === t('projLandFailed') && x.msg === t('working'))).toBe(true);
  expect(r.sent.some((m) => m.type === 'switch')).toBe(false);
});

it('a fresh window without a session id yet: a chosen session opens at once, new needs nothing', () => {
  const r = rig();
  startLanding(r.store, B);
  r.open();
  r.session(null);
  expect(r.sent.filter((m) => m.type === 'switch')).toEqual([{ type: 'switch', id: B, dir: '/r' }]);
  const n = rig();
  startLanding(n.store, 'new');
  n.open();
  n.session(null);
  n.session(A);
  expect(n.sent.some((m) => m.type === 'switch')).toBe(false);
});
