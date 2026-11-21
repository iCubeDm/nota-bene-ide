import { afterEach, expect, it } from 'vitest';
import type { Comment, MediaAnchor } from '@nota-bene/shared';
import { setLang } from '@/core/i18n/index.ts';
import { whereOf } from './send.ts';

const media = (over: Partial<MediaAnchor> = {}): Comment => ({
  id: 'c1', text: 'thin', status: 'pending', createdAt: 1,
  anchor: {
    kind: 'media', source: { kind: 'file', path: 'media/a.mp4' }, width: 800, height: 600,
    shapes: [{ kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }], ...over,
  },
});
afterEach(() => setLang('en'));

it('a media comment names the file, the time and the frame size; another source keeps its ref', () => {
  setLang('en');
  expect(whereOf(media({ time: 4.24 }))).toBe('media/a.mp4 @ 0:04.240 · 800×600');
  expect(whereOf(media({ source: { kind: 'file', path: 'a.png', ref: 'feat' } }))).toBe('a.png @ feat · 800×600');
});

it('a cut comment names the edit and the time on the timeline (issue 430)', () => {
  setLang('en');
  const cut: Comment = { id: 'k', text: 'x', status: 'pending', createdAt: 1, anchor: { kind: 'cut', source: { kind: 'file', path: 'e.nbcut.json' }, time: 61.5 } };
  expect(whereOf(cut)).toBe('e.nbcut.json · timeline 1:01.500');
  setLang('ru');
  expect(whereOf(cut)).toBe('e.nbcut.json · таймлайн 1:01.500');
});
