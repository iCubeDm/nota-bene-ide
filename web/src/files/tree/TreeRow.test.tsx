import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { PATH_MIME } from '@/cut/drag.ts';
import { PATHS_MIME } from '@/files/drag.ts';
import { renderDir, type RowsCtx } from './TreeRow.tsx';

afterEach(cleanup);
const ctx = (src: string, sel: string[] = []): RowsCtx => ({
  entries: { '': [{ name: 'clip.mp4', dir: false }, { name: 'notes.md', dir: false }] } as RowsCtx['entries'],
  dirs: [], f: '', counts: {}, activePath: null, src, ref: undefined, sel, onToggle: () => {}, onPick: () => {},
});

it('a media file of this folder drags its path onto an edit; other sources do not', () => {
  const { container, unmount } = render(<div>{renderDir(ctx('here'), '', 0)}</div>);
  const row = container.querySelector('[data-path="clip.mp4"]')!;
  expect(row).toHaveAttribute('draggable', 'true');
  const set: Record<string, string> = {};
  fireEvent.dragStart(row, { dataTransfer: { setData: (k: string, v: string) => void (set[k] = v), effectAllowed: '' } });
  expect(set[PATH_MIME]).toBe('clip.mp4');
  unmount();
  const other = render(<div>{renderDir(ctx('wt:1'), '', 0)}</div>);
  const set2: Record<string, string> = {};
  fireEvent.dragStart(other.container.querySelector('[data-path="clip.mp4"]')!, { dataTransfer: { setData: (k: string, v: string) => void (set2[k] = v), effectAllowed: '' } });
  expect(set2[PATH_MIME]).toBeUndefined();
});

const drag = (row: Element) => {
  const set: Record<string, string> = {};
  fireEvent.dragStart(row, { dataTransfer: { setData: (k: string, v: string) => void (set[k] = v), effectAllowed: '' } });
  return set;
};

it('every file row drags: its path to the composer, and out of the browser as a download of /file (issue 461)', () => {
  const { container } = render(<div>{renderDir(ctx('here'), '', 0)}</div>);
  const row = container.querySelector('[data-path="notes.md"]')!;
  expect(row).toHaveAttribute('draggable', 'true');
  const set = drag(row);
  expect(JSON.parse(set[PATHS_MIME]!)).toEqual(['notes.md']);
  expect(set[PATH_MIME]).toBeUndefined(); // the timeline takes media only
  expect(set.DownloadURL).toBe(`application/octet-stream:notes.md:${location.origin}/file?path=notes.md&download=1`);
  expect(set.DownloadURL).not.toMatch(/#t=|key|token/);
});

it('a row in the selection drags the whole selection, in pick order', () => {
  const { container } = render(<div>{renderDir(ctx('here', ['notes.md', 'clip.mp4']), '', 0)}</div>);
  const set = drag(container.querySelector('[data-path="clip.mp4"]')!);
  expect(JSON.parse(set[PATHS_MIME]!)).toEqual(['notes.md', 'clip.mp4']);
  expect(set[PATH_MIME]).toBe('clip.mp4');
});

it('another source drags out as a download of its own file, not as a path of this folder', () => {
  const { container } = render(<div>{renderDir(ctx('wt:1'), '', 0)}</div>);
  const row = container.querySelector('[data-path="notes.md"]')!;
  expect(row).toHaveAttribute('draggable', 'true');
  const set = drag(row);
  expect(set[PATHS_MIME]).toBeUndefined();
  expect(set.DownloadURL).toBe(`application/octet-stream:notes.md:${location.origin}/file?path=notes.md&src=wt%3A1&download=1`);
});
