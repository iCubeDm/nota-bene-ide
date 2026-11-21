/**
 * After a pick in a list (▾, Cmd+E): the tab it activated is scrolled into view (also when it was active already, so
 * the activation effect did not run) and takes the focus, not a now-hidden pane.
 */
export const focusTab = (id: string) =>
  requestAnimationFrame(() => {
    const el = [...document.querySelectorAll<HTMLElement>('[role="tablist"] [data-tab]')].find((n) => n.dataset.tab === id);
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    el?.focus({ preventScroll: true });
  });
