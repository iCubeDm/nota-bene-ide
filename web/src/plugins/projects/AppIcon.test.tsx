import { cleanup, render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/core/i18n/index.ts';
import { testStore } from '@/core/testing';
import { Toasts } from '@/core/shell/Toasts.tsx';
import { resetToasts } from '@/core/shell/toast.ts';
import { AppIcon } from './AppIcon.tsx';

let local = true;
vi.mock('@/core/net/local.ts', async (orig) => ({ ...(await orig<typeof import('@/core/net/local.ts')>()), isLocalPage: () => local }));

let answer: { can: boolean; installed: boolean };
let store: ReturnType<typeof testStore>['store'];
const render = () => rtlRender(<Provider store={store}><AppIcon /><Toasts /></Provider>);
const toasts = () => screen.queryAllByTestId('toast');
const DAY = 86_400_000;
beforeEach(() => {
  setLang('en');
  localStorage.clear();
  resetToasts();
  local = true;
  ({ store } = testStore());
  answer = { can: true, installed: false };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      answer = { can: true, installed: true };
      return new Response(JSON.stringify({ path: '/apps/Nota Bene.app' }));
    }
    return new Response(JSON.stringify(answer));
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const offer = async () => {
  const el = await screen.findByTestId('toast');
  expect(el).toHaveTextContent('Add Nota Bene to your apps');
  expect(el).toHaveTextContent('A click opens your last project');
};

it('no icon yet: the offer is a notification; Add installs it and the offer goes', async () => {
  render();
  await offer();
  await userEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(fetch).toHaveBeenCalledWith('/system/shortcut/install', expect.objectContaining({ method: 'POST' }));
  await vi.waitFor(() => expect(screen.queryByText('Add Nota Bene to your apps')).toBeNull());
});

it('an icon already there, or a computer that cannot have one: nothing', async () => {
  answer = { can: true, installed: true };
  const a = render();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(toasts()).toHaveLength(0);
  a.unmount();
  answer = { can: false, installed: false };
  render();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(toasts()).toHaveLength(0);
});

it('Not now hides it for 30 days', async () => {
  const now = Date.now();
  const a = render();
  await offer();
  await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
  expect(screen.queryByText('Add Nota Bene to your apps')).toBeNull();
  a.unmount();
  vi.spyOn(Date, 'now').mockReturnValue(now + 29 * DAY);
  const b = render();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(toasts()).toHaveLength(0);
  b.unmount();
  vi.spyOn(Date, 'now').mockReturnValue(now + 31 * DAY);
  render();
  await offer();
});

it('a page from another device (the phone, a paired computer) never offers it: the icon would go on this computer', async () => {
  local = false;
  render();
  await new Promise((r) => setTimeout(r, 20));
  expect(fetch).not.toHaveBeenCalled();
  expect(toasts()).toHaveLength(0);
});

it('the window goes (another agent, a closed tab): its offer goes with it', async () => {
  const a = render();
  await offer();
  a.rerender(<Provider store={store}><Toasts /></Provider>);
  expect(toasts()).toHaveLength(0);
});
