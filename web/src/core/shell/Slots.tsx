import { createContext, useContext, type FC } from 'react';
import { useRegistry } from '@/core/store/store.ts';
import type { Slot, SlotName } from '@/sdk/registry.ts';

/** The frame's own part of a slot; module-level, so its component is the same on every render. */
export type Own = Omit<Slot, 'slot' | 'on'>;

/** True under the server's home page (issue 651): its slots show the parts that say they show there (`Slot.on`). */
export const OnHome = createContext(false);
/** Whether this part is on the server's home page (issue 651). */
export const useOnHome = (): boolean => useContext(OnHome);

/**
 * The plugins' parts of slot `at`, merged with the frame's `own` parts by ascending order (issue 511). A plugin's part at
 * an order the frame takes is an error, as two plugins' parts at one order are in `buildRegistry`. On the home page only
 * the parts with `on` show, elsewhere only the others and `both` (issue 651); the frame's own always do.
 */
export function Slots({ at, own = [] }: { at: SlotName; own?: readonly Own[] }) {
  const home = useContext(OnHome);
  const parts = (useRegistry().slots.get(at) ?? []).filter((p) => (home ? p.on !== undefined : p.on !== 'home'));
  const taken = parts.find((p) => own.some((o) => o.order === p.order));
  if (taken) throw new Error(`slots: the slot "${at}" has a plugin's part at the frame's order ${taken.order}`);
  const all = own.length ? [...parts, ...own].sort((a, b) => a.order - b.order) : parts;
  return <>{all.map(({ order, render: Part }: { order: number; render: FC }) => <Part key={order} />)}</>;
}
