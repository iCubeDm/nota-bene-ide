import { useEffect, useState } from 'react';

const inside = (el: Element | null, node: EventTarget | null) => !!el && node instanceof Node && el.contains(node);

/**
 * True while the focus is inside the element `el()` returns (looked up on every focus change, so the element may come
 * and go). Read from the focus events themselves: during a focusout the document's activeElement is not settled yet.
 */
export function useFocusWithin(el: () => Element | null): boolean {
  const [focused, setFocused] = useState(() => inside(el(), document.activeElement));
  useEffect(() => {
    const onIn = (e: FocusEvent) => setFocused(inside(el(), e.target));
    const onOut = (e: FocusEvent) => setFocused(inside(el(), e.relatedTarget));
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    setFocused(inside(el(), document.activeElement));
    return () => { document.removeEventListener('focusin', onIn); document.removeEventListener('focusout', onOut); };
  }, [el]);
  return focused;
}
