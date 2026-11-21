import type { FC } from 'react';
import { useRegistry } from '@/store/store.ts';
import type { Slot, SlotName } from '@/sdk/registry.ts';

/** The frame's own part of a slot; module-level, so its component is the same on every render. */
export type Own = Omit<Slot, 'slot'>;

/** The plugins' parts of slot `at`, merged with the frame's `own` parts by ascending order (issue 511). */
export function Slots({ at, own = [] }: { at: SlotName; own?: readonly Own[] }) {
  const parts = useRegistry().slots.get(at) ?? [];
  const all = own.length ? [...parts, ...own].sort((a, b) => a.order - b.order) : parts;
  return <>{all.map(({ order, render: Part }: { order: number; render: FC }) => <Part key={order} />)}</>;
}
