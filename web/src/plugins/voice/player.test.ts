import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { release, resetPlayer, seek, toggle } from './player.ts';

type Fake = { src: string; paused: boolean; pause: Mock<() => void> };
const made: Fake[] = [];
beforeEach(() => {
  made.length = 0;
  vi.stubGlobal('Audio', class {
    src: string; paused = true; ended = false; currentTime = 0; preload = '';
    pause = vi.fn(() => { this.paused = true; });
    play = vi.fn(() => { this.paused = false; return Promise.resolve(); });
    addEventListener() {}
    constructor(src: string) { this.src = src; made.push(this as never); }
  });
});
afterEach(() => { resetPlayer(); vi.unstubAllGlobals(); });

it('keeps only a few audio elements: the least recently used idle one is released', () => {
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) toggle(id);
  expect(made).toHaveLength(6);
  made.forEach((m) => m.pause()); // all idle again
  toggle('a'); // 'a' was pruned: a new element for it
  expect(made).toHaveLength(7);
  expect(made[0]!.pause).toHaveBeenCalled(); // the pruned one was stopped
});

it('the one playing is not pruned', () => {
  toggle('a'); // plays
  for (const id of ['b', 'c', 'd', 'e', 'f']) seek(id, 0); // seeking pauses nothing
  toggle('a'); // pauses the same element: it was never replaced
  expect(made.filter((m) => m.src === '/voice/a')).toHaveLength(1);
});

it('release forgets one element', () => {
  toggle('a');
  release('a');
  toggle('a');
  expect(made).toHaveLength(2);
});
