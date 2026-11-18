import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { FileView } from './FileView.tsx';
import { filesSlice } from './slice.ts';

// the file never finishes loading: its jump keeps waiting for the view
beforeEach(() => { setLang('en'); vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const view = (store: ReturnType<typeof makeStore>) => <Provider store={store}><TooltipProvider><FileView path="notes.txt" active /></TooltipProvider></Provider>;
const newStore = () => makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });

it('closing a tab drops the jump still waiting for it', async () => {
  const store = newStore();
  const { unmount } = render(view(store));
  act(() => void store.dispatch(filesSlice.actions.requestJump({ path: 'notes.txt', src: 'here', id: 'c1' })));
  expect(store.getState().files.jump).toMatchObject({ id: 'c1' });
  unmount(); // the tab closes
  await Promise.resolve(); // the drop waits one microtask (StrictMode's probe unmount is not a close)
  expect(store.getState().files.jump).toBeNull(); // nothing carries to the next open of the file
});

it('under StrictMode (dev) the simulated unmount does not drop a jump requested before the view mounted', async () => {
  const store = newStore();
  // a jump to a file that is not open yet: the same click opens the tab and requests it
  act(() => void store.dispatch(filesSlice.actions.requestJump({ path: 'notes.txt', src: 'here', id: 'c1' })));
  const { unmount } = render(<StrictMode>{view(store)}</StrictMode>);
  await new Promise((r) => setTimeout(r, 50));
  expect(store.getState().files.jump).toMatchObject({ id: 'c1' }); // the mount -> cleanup -> mount probe is not a close
  unmount(); // a real close still drops it
  await Promise.resolve();
  expect(store.getState().files.jump).toBeNull();
});
