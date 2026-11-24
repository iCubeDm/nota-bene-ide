// Reordering by drag (issue 638): an item of a strip moves among the items of its own drag type; it lands before or after
// the item under the pointer, by which half of it the pointer is on. The item under a drag says where (`data-drop`).
import { useState, type DragEvent, type HTMLAttributes } from 'react';

/** The marks of `data-drop`: a line on the side the dragged item would land. */
export const DROP_MARK = 'data-[drop=before]:shadow-[inset_2px_0_0_var(--color-primary)] data-[drop=after]:shadow-[inset_-2px_0_0_var(--color-primary)]';

type DragProps = Pick<HTMLAttributes<HTMLElement>, 'draggable' | 'onDragStart' | 'onDragOver' | 'onDragLeave' | 'onDrop'> & { 'data-drop'?: 'before' | 'after' };

/** The props of item `id` for drags of `type` (lower case: a browser lowers it); off: none. */
export function useDragOrder(type: string, id: string, move: (id: string, to: string, after: boolean) => void, on = true): DragProps {
  const [mark, setMark] = useState<'before' | 'after' | null>(null);
  if (!on) return {};
  const after = (e: DragEvent<HTMLElement>) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientX > r.left + r.width / 2; };
  return {
    draggable: true,
    ...(mark ? { 'data-drop': mark } : {}),
    onDragStart: (e) => { e.stopPropagation(); e.dataTransfer.setData(type, id); e.dataTransfer.effectAllowed = 'move'; },
    onDragOver: (e) => {
      if (![...e.dataTransfer.types].includes(type)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setMark(after(e) ? 'after' : 'before');
    },
    onDragLeave: () => setMark(null),
    onDrop: (e) => {
      setMark(null);
      const from = e.dataTransfer.getData(type);
      if (!from) return;
      e.preventDefault();
      if (from !== id) move(from, id, after(e));
    },
  };
}
