/**
 * A conversation's commentable items in the DOM (issue 563): the chat's feed and a subagent's tab draw them inside a
 * box marked `data-items`, each item's root marked `data-item-id`. The comments find them through these, not through
 * the feed's own markup.
 */
export const itemsBox = (pane: ParentNode): HTMLElement | null => pane.querySelector<HTMLElement>('[data-items]');
export const itemRoots = (root: ParentNode): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[data-items] [data-item-id]')];
/** The item root `n` sits in; null outside a conversation's items. */
export const itemRootOf = (n: Element): HTMLElement | null => (n.closest('[data-items]') ? n.closest<HTMLElement>('[data-item-id]') : null);
