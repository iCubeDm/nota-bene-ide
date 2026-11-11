// whether the prompt history list is open; Alt+H (the keymap) and the button toggle it, the list itself reads it
let isOpen = false;
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };
export const promptHistoryModal = {
  open: () => { isOpen = true; emit(); },
  close: () => { isOpen = false; emit(); },
  get: () => isOpen,
  subscribe: (f: () => void) => { subs.add(f); return () => void subs.delete(f); },
};
