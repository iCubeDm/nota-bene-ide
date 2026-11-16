import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { FileView } from './FileView.tsx';

let body: string;
beforeEach(() => {
  setLang('en');
  body = JSON.stringify({
    version: 1, width: 640, height: 360, fps: 30,
    tracks: [{ id: 'v1', kind: 'video' }],
    clips: [{ id: 'c1', track: 'v1', src: 'media/clip.mp4', at: 0, out: 3 }],
  });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(body.length) } });
    return new Response(body);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(path: string) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  return render(<Provider store={store}><TooltipProvider><FileView path={path} active /></TooltipProvider></Provider>);
}

it('an edit opens as its timeline; Source shows its JSON, Timeline goes back', async () => {
  const { container } = setup('edits/trip.nbcut.json');
  expect(await screen.findByText('clip.mp4')).toBeInTheDocument();
  expect(container.querySelector('[data-lane="v1"]')).not.toBeNull();
  expect(screen.queryByRole('button', { name: 'Wrap lines' })).toBeNull();
  const group = screen.getByRole('group', { name: 'Show the timeline or the JSON source' });
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  expect(container.querySelector('[data-file-path="edits/trip.nbcut.json"] pre')?.textContent).toContain('"media/clip.mp4"');
  expect(container.querySelector('[data-timeline]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));
  expect(container.querySelector('[data-timeline]')).not.toBeNull();
  expect(group).toBeInTheDocument();
});

it('a broken edit says what is wrong and its text is one click away', async () => {
  body = '{ "version": 1, "tracks": [';
  const { container } = setup('trip.nbcut.json');
  expect(await screen.findByText(/The edit is not valid JSON/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  expect(container.querySelector('[data-file-path] pre')?.textContent).toContain('"tracks"');
});

it('another .json file stays text', async () => {
  const { container } = setup('trip.json');
  await screen.findByText(/media\/clip\.mp4/);
  expect(container.querySelector('[data-timeline]')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Timeline' })).toBeNull();
});
