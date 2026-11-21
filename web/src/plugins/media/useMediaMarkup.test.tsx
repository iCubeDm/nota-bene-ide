import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Provider } from 'react-redux';
import { expect, it, vi } from 'vitest';
import { testStore } from '@/testing';
import { useMediaMarkup } from './useMediaMarkup.ts';

const deleteMarks = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./markup/createMediaComment.ts', async (orig) => ({ ...(await orig<object>()), deleteMarks }));

// issue 545: a session switch during a drawing's Add drops its written marks through the pending comment's `discard`
it('a drawing\'s pending comment discards its own marks', () => {
  const { store } = testStore();
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  const { result } = renderHook(() => useMediaMarkup({
    tabId: 'file:a.png', path: 'a.png', ref: undefined, active: true, marking: true, mediaUrl: '', mediaEl: { current: null },
  }), { wrapper });
  const img = Object.defineProperties(document.createElement('img'), { naturalWidth: { value: 40 }, naturalHeight: { value: 30 } });
  act(() => result.current.imgRef(img));
  act(() => result.current.onMarkAdd([], new DOMRect()));
  const pending = result.current.markPopup!;
  void pending.discard!();
  expect(deleteMarks).toHaveBeenCalledWith(pending.id);
});
