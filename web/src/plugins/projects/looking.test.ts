import { expect, it } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { startLooking } from './looking.ts';

function rig(o: { hidden?: boolean; focus?: boolean; protocol?: number } = {}) {
  let focus = o.focus ?? true;
  const doc = Object.assign(new EventTarget(), { hidden: o.hidden ?? false, hasFocus: () => focus }) as unknown as Document & { hidden: boolean };
  const win = new EventTarget() as unknown as Window;
  let hello: { protocol: number } | null = { protocol: o.protocol ?? 41 };
  const sent: ClientMessage[] = [];
  const listeners = new Set<(ev: ServerEvent) => void>();
  const conn = {
    hello: () => hello,
    send: (m: ClientMessage) => (sent.push(m), true),
    onEvent: (fn: (ev: ServerEvent) => void) => (listeners.add(fn), () => void listeners.delete(fn)),
  };
  const stop = startLooking(conn, doc, win);
  const ons = () => sent.map((m) => (m.type === 'looking' ? m.on : null));
  const helloFrom = (protocol: number) => {
    hello = { protocol };
    for (const fn of listeners) fn({ kind: 'hello', protocol });
  };
  return { doc, win, ons, stop, helloFrom, listeners, focusOn: (f: boolean) => { focus = f; } };
}

it('a visible, focused page says it looks at once', () => {
  expect(rig().ons()).toEqual([true]);
  expect(rig({ focus: false }).ons()).toEqual([false]);
  expect(rig({ hidden: true }).ons()).toEqual([false]);
});

it('looking follows focus and visibility, told on a change only', () => {
  const r = rig();
  r.focusOn(false);
  r.win.dispatchEvent(new Event('blur'));
  r.win.dispatchEvent(new Event('blur'));
  r.focusOn(true);
  r.win.dispatchEvent(new Event('focus'));
  r.doc.hidden = true;
  r.doc.dispatchEvent(new Event('visibilitychange'));
  expect(r.ons()).toEqual([true, false, true, false]);
});

it('it is told again at each hello, and never to a server before 41', () => {
  const r = rig({ protocol: 40 });
  expect(r.ons()).toEqual([]);
  r.win.dispatchEvent(new Event('blur'));
  expect(r.ons()).toEqual([]);
  r.helloFrom(41);
  expect(r.ons()).toEqual([true]);
  r.helloFrom(41);
  expect(r.ons()).toEqual([true, true]);
});

it('stop removes the listeners', () => {
  const r = rig();
  r.stop();
  r.focusOn(false);
  r.win.dispatchEvent(new Event('blur'));
  expect(r.ons()).toEqual([true]);
  expect(r.listeners.size).toBe(0);
});
