import { expect, it } from 'vitest';
import { events, testStore } from '@/core/testing';
import { serverEvent } from '@/sdk';
import { PLUGINS } from '../../plugins.ts';
import { setDraft } from '../../plugins/composer/slice.ts';
import { selectPagePause } from './pagePause.ts';

const paused = (s: ReturnType<typeof testStore>['store'], draft: boolean) => selectPagePause(s.getState(), { draft }, PLUGINS);

it('an idle page is a pause, with or without the draft counted', () => {
  const { store } = testStore();
  expect([paused(store, true), paused(store, false)]).toEqual([true, true]);
});

it('core: a turn is no pause', () => {
  const { store } = testStore({ events: [events.user({ text: 'hi' })] });
  expect(paused(store, false)).toBe(false);
});

it('composer: a typed draft is no pause only when the draft counts', () => {
  const { store } = testStore();
  store.dispatch(setDraft('half a thought'));
  expect([paused(store, true), paused(store, false)]).toEqual([false, true]);
});

it('tasks: a running task is no pause', () => {
  const { store } = testStore();
  store.dispatch(serverEvent(events.agent({ t: 'task', id: 'k1', phase: 'started', desc: 'build', type: 'local_bash' })));
  expect(paused(store, false)).toBe(false);
});

it('the pause is the AND of every plugin\'s: no plugins, only the core part', () => {
  const { store } = testStore();
  store.dispatch(setDraft('x'));
  expect(selectPagePause(store.getState(), { draft: true }, [])).toBe(true);
  expect(selectPagePause(store.getState(), { draft: true }, [{ id: 'busy', pause: () => false }])).toBe(false);
});
