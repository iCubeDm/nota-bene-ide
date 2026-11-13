import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { CompactingLine, DoneLine, MarkerLine, NoticeLine } from './DoneLine.tsx';

afterEach(() => setLang('ru'));

it('labels status and duration through t(), with the error text', () => {
  setLang('ru');
  const { container, rerender } = render(<DoneLine item={{ kind: 'done', key: 'k', secs: 3, ts: 0, status: 'failed', error: 'boom' }} />);
  expect(container).toHaveTextContent('ошибка · 3с · boom');
  setLang('en');
  rerender(<DoneLine item={{ kind: 'done', key: 'k', secs: 2, ts: 0, status: 'interrupted' }} />);
  expect(container).toHaveTextContent(/^interrupted · 2s$/);
});

it('a resume notice is muted and follows the language', () => {
  setLang('en');
  const { container } = render(<NoticeLine item={{ kind: 'notice', key: 'k', text: 'abcdefgh' }} />);
  act(() => setLang('ru'));
  const muted = container.querySelector('[data-kind="notice"]')!;
  expect(muted).toHaveTextContent('↻ продолжение сессии abcdefgh');
  expect(muted).not.toHaveClass('text-destructive');
});

it('the compacted line tells how long it took; a failed one is red with the error', () => {
  setLang('ru');
  const { container, rerender } = render(<MarkerLine item={{ kind: 'marker', key: 'k', what: 'compacted', pre: 850000, ms: 72000, ts: 0 }} />);
  expect(container).toHaveTextContent('⇣ контекст сжат · было 850k токенов · за 1:12');
  rerender(<MarkerLine item={{ kind: 'marker', key: 'k', what: 'compactFailed', error: 'boom', ts: 0 }} />);
  expect(container.querySelector('[data-kind="marker"]')).toHaveClass('text-destructive');
  expect(container).toHaveTextContent('⇣ сжать контекст не удалось: boom');
});

it('a cleared line offers to archive the conversation before it; done, it says so', async () => {
  setLang('en');
  const fetch = vi.fn(async () => new Response('ok'));
  vi.stubGlobal('fetch', fetch);
  try {
    const { container, rerender } = render(<MarkerLine item={{ kind: 'marker', key: 'k', what: 'cleared', ts: 0 }} />);
    expect(screen.queryByRole('button')).toBeNull(); // no previous id: nothing to offer
    rerender(<MarkerLine item={{ kind: 'marker', key: 'k', what: 'cleared', ts: 0, prev: '11111111-1111-4111-8111-111111111111' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Archive previous session' }));
    expect(fetch).toHaveBeenCalledWith('/sessions/archive', expect.objectContaining({ body: JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', archived: true }) }));
    await waitFor(() => expect(container).toHaveTextContent('previous session archived'));
    expect(screen.queryByRole('button')).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('a refused archive of the previous conversation says why and can be tried again', async () => {
  setLang('en');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('disk full', { status: 500 })));
  try {
    const { container } = render(<MarkerLine item={{ kind: 'marker', key: 'k', what: 'cleared', ts: 0, prev: '11111111-1111-4111-8111-111111111111' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Archive previous session' }));
    await waitFor(() => expect(container).toHaveTextContent('Could not archive the session: disk full'));
    expect(screen.getByRole('button', { name: 'Archive previous session' })).toBeEnabled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('the compacting line counts from the server ts and fills the bar towards the usual time', () => {
  vi.useFakeTimers();
  try {
    localStorage.setItem('nb.compactMs', JSON.stringify([60_000]));
    setLang('ru');
    let clock = 10_000 + 30_000;
    const { container } = render(<CompactingLine since={10_000} now={() => clock} />);
    expect(container).toHaveTextContent('⇣ сжимаю контекст · 0:30 · обычно ~1:00');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
    clock += 30_000;
    act(() => vi.advanceTimersByTime(500));
    expect(container).toHaveTextContent('· 1:00 ·');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '90');
  } finally {
    vi.useRealTimers();
    localStorage.clear();
  }
});
