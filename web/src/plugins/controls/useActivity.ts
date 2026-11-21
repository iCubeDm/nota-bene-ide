import { useEffect } from 'react';
import { pageVisible, useAppDispatch, reportActivity } from '@/sdk';

const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'focus'] as const;

/**
 * Any use of a visible page (reading and scrolling count, not only typing) restarts the server's idle-compaction
 * clock. The thunk throttles, so the listeners can be cheap and many.
 */
export function useActivity(): void {
  const dispatch = useAppDispatch();
  useEffect(() => {
    const on = () => {
      if (pageVisible()) dispatch(reportActivity());
    };
    for (const e of EVENTS) window.addEventListener(e, on, { capture: true, passive: true });
    document.addEventListener('visibilitychange', on);
    return () => {
      for (const e of EVENTS) window.removeEventListener(e, on, { capture: true });
      document.removeEventListener('visibilitychange', on);
    };
  }, [dispatch]);
}

/** useActivity as a part of the frame (a slot), rendering nothing. */
export function Activity(): null {
  useActivity();
  return null;
}
