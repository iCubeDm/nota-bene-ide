import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { PATH_MIME } from '@/cut/drag.ts';
import { renderDir, type RowsCtx } from './TreeRow.tsx';

afterEach(cleanup);
const ctx = (src: string): RowsCtx => ({
  entries: { '': [{ name: 'clip.mp4', dir: false }, { name: 'notes.md', dir: false }] } as RowsCtx['entries'],
  dirs: [], f: '', counts: {}, activePath: null, src, ref: undefined, sel: [], onToggle: () => {}, onPick: () => {},
});

it('a media file of this folder drags its path onto an edit; other files and other sources do not', () => {
  const { container, unmount } = render(<div>{renderDir(ctx('here'), '', 0)}</div>);
  const row = container.querySelector('[data-path="clip.mp4"]')!;
  expect(row).toHaveAttribute('draggable', 'true');
  const set: Record<string, string> = {};
  fireEvent.dragStart(row, { dataTransfer: { setData: (k: string, v: string) => void (set[k] = v), effectAllowed: '' } });
  expect(set[PATH_MIME]).toBe('clip.mp4');
  expect(container.querySelector('[data-path="notes.md"]')).not.toHaveAttribute('draggable');
  unmount();
  const other = render(<div>{renderDir(ctx('wt:1'), '', 0)}</div>);
  expect(other.container.querySelector('[data-path="clip.mp4"]')).not.toHaveAttribute('draggable');
});
