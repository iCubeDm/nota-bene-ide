import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { recheckUpdate, UpdateNotice } from './UpdateNotice.tsx';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

let answer: unknown;
beforeEach(() => {
  setLang('en');
  localStorage.clear();
  answer = { current: '1.2.0', latest: '1.3.0' };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const button = () => screen.findByRole('button', { name: '↑ 1.3.0' });

it('a newer version: the header says so, and the popover says how to update', async () => {
  render(<UpdateNotice />);
  await userEvent.click(await button());
  expect(screen.getByText('npm i -g nota-bene-ide@1.3.0')).toBeInTheDocument();
  expect(screen.getByText(/You run 1\.2\.0/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute('href', expect.stringContaining('/releases/tag/v1.3.0'));
});

it('no newer version, or a server that cannot say: nothing shows', async () => {
  answer = { current: '1.3.0', latest: null };
  const { container, unmount } = render(<UpdateNotice />);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
  unmount();
  vi.mocked(fetch).mockResolvedValue(new Response('nope', { status: 500 }));
  const again = render(<UpdateNotice />);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(again.container).toBeEmptyDOMElement();
});

it('turned off in Settings: the notice goes without waiting for a focus', async () => {
  render(<UpdateNotice />);
  await button();
  answer = { current: '1.2.0', latest: null };
  act(() => recheckUpdate());
  await vi.waitFor(() => expect(screen.queryByRole('button', { name: '↑ 1.3.0' })).toBeNull());
});

it('Later hides this version across a reload, and the next version shows again', async () => {
  const { unmount } = render(<UpdateNotice />);
  await userEvent.click(await button());
  await userEvent.click(screen.getByRole('button', { name: 'Later' }));
  expect(screen.queryByRole('button', { name: '↑ 1.3.0' })).toBeNull();
  unmount();
  const asks = () => vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/system/update')).length;
  render(<UpdateNotice />);
  await vi.waitFor(() => expect(asks()).toBe(2));
  expect(screen.queryByRole('button', { name: '↑ 1.3.0' })).toBeNull();
  cleanup();
  answer = { current: '1.2.0', latest: '1.4.0' };
  render(<UpdateNotice />);
  expect(await screen.findByRole('button', { name: '↑ 1.4.0' })).toBeInTheDocument();
});

it('the popover shows what the newer version changes, asked once when it opens', async () => {
  vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith('/system/update/changes')
    ? { text: '## 1.3.0 — 2026-11-02\n\n- Themes: Darcula is the new default.' }
    : answer)));
  render(<UpdateNotice />);
  await userEvent.click(await button());
  const box = await screen.findByTestId('update-changes');
  expect(box).toHaveTextContent('Themes: Darcula is the new default.');
  expect(screen.getByRole('region', { name: 'What’s new' })).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  await userEvent.click(await button());
  const asked = vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/system/update/changes'));
  expect(asked).toHaveLength(1);
});

it('no changelog to be had: the popover is as before', async () => {
  vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith('/system/update/changes') ? { text: null } : answer)));
  render(<UpdateNotice />);
  await userEvent.click(await button());
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).endsWith('/changes'))).toBe(true));
  expect(screen.queryByTestId('update-changes')).toBeNull();
  expect(screen.getByRole('link', { name: 'Release notes' })).toBeInTheDocument();
});
