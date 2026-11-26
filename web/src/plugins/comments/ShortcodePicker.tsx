import { placeListFor, revealSelected, AT_RE, useComposerField, type Field } from '@/sdk';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { loadEmoji, searchShortcodes } from './emoji.ts';

// `:` at a word start + >=2 chars, up to the caret; optionally already closed by a second colon
const TOKEN = /(^|\s):([a-z0-9_+-]{2,})(:?)$/i;

interface Item { code: string; emoji: string }
interface Open { items: Item[]; sel: number; start: number }

/**
 * GitHub-style `:code` autocomplete for any message field. Keys are intercepted at WINDOW capture so that,
 * while the list is open, Esc/Enter/Tab never reach the host's own document-level handlers (popup Esc,
 * composer send). Insertion goes through the field, which tells the host of the change.
 */
export function ShortcodePicker({ target }: { target: RefObject<Field | null> }) {
  const [state, setState] = useState<Open | null>(null);
  const live = useRef<Open | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const set = (s: Open | null) => { live.current = s; setState(s); };

  const insert = (f: Field, start: number, emoji: string) => {
    const end = f.selection().from;
    const text = f.text();
    // the caret may have moved since the list was built: never insert over a stale token
    if (!/^:[a-z0-9_+-]{2,}:?$/i.test(text.slice(start, end)) || (start > 0 && !/\s/.test(text[start - 1]!))) return;
    f.replace(start, end, emoji);
  };

  useEffect(() => {
    const f = target.current;
    if (!f) return;
    let dead = false;
    const update = (typed = false) => {
      if (dead) return;
      const before = f.text().slice(0, f.selection().from);
      const m = TOKEN.exec(before);
      if (!m) return set(null);
      const code = m[2].toLowerCase();
      const start = before.length - m[0].length + m[1].length;
      // the closer trigger wins (MentionPicker has the mirror rule): an `@` after the `:` owns the keys
      const at = AT_RE.exec(before);
      if (at && before.length - at[2].length - 1 > start) return set(null);
      if (m[3]) { // closing colon: replace at once if the code exists, otherwise leave the text alone
        set(null);
        if (!typed) return; // only typing the closing colon replaces, never a caret jump
        const hit = searchShortcodes(code).find((e) => e.code.toLowerCase() === code);
        if (hit) insert(f, start, hit.emoji);
        return;
      }
      const items = searchShortcodes(code, 8);
      if (!items.length) return set(null);
      const cur = live.current;
      if (cur && cur.start === start && cur.items.map((i) => i.code).join() === items.map((i) => i.code).join()) return; // keep the selection
      set({ items, sel: 0, start });
    };
    const onInput = () => {
      // the first colon warms the (lazy, ~600 KB) emoji data; re-run once it has arrived
      const caret = f.selection().from;
      // a caret that moved while loading must not trigger the typed-only closing-colon replacement
      if (/:[a-z0-9_+-]*$/i.test(f.text().slice(0, caret))) void loadEmoji().then(() => update(f.selection().from === caret), (err) => console.warn('emoji data failed to load', err));
      update(true);
    };
    const close = () => set(null);
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      if (!s || e.target !== f.element || e.isComposing) return;
      if (e.key === 'Tab' && e.shiftKey) return set(null); // Shift+Tab is the composer's mode cycle: close, let it through
      let handled = true;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const d = e.key === 'ArrowDown' ? 1 : -1;
        set({ ...s, sel: (s.sel + d + s.items.length) % s.items.length });
      } else if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) || e.key === 'Tab') {
        set(null);
        insert(f, s.start, s.items[s.sel].emoji);
      } else if (e.key === 'Escape') set(null);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    // typing; a click; a caret moved by keys while the list is open (closes it once the caret leaves the token)
    const off = f.onUpdate((u) => { if (u.doc) onInput(); else if (u.pointer || live.current) update(); });
    f.element.addEventListener('blur', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      dead = true;
      off();
      f.element.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [target]);

  // above the field when it fits, else the roomier side, height capped to that side (placeList)
  useLayoutEffect(() => {
    const f = target.current;
    if (!state || !f || !menu.current) return;
    setPos(placeListFor(menu.current, f.element));
  }, [state?.items, target]);
  // the selected option scrolls into view inside the list only: scrollIntoView would scroll the document too
  useLayoutEffect(() => {
    if (menu.current) revealSelected(menu.current);
  }, [state?.sel, state?.items, pos]);

  if (!state) return null;
  const pick = (k: number) => {
    const f = target.current;
    if (!f) return;
    set(null);
    f.focus();
    insert(f, state.start, state.items[k].emoji);
  };
  return (
    <div
      ref={menu}
      role="listbox"
      className="fixed z-20 max-h-[min(20rem,40vh)] overflow-y-auto w-60 rounded-[10px] border border-border bg-popover p-1 shadow-[0_10px_32px_color-mix(in_oklch,var(--shade)_50%,transparent)]"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {state.items.map((it, k) => (
        <div
          key={it.code}
          role="option"
          aria-selected={k === state.sel}
          onMouseDown={(e) => e.preventDefault() /* keep focus in the field */}
          onClick={() => pick(k)}
          className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 font-mono text-[0.78125rem] text-foreground ${k === state.sel ? 'bg-primary/15' : 'hover:bg-accent'}`}
        >
          <span className="w-5 text-center text-[0.9375rem] leading-none">{it.emoji}</span>
          <span className="truncate">:{it.code}:</span>
        </div>
      ))}
    </div>
  );
}

/** The shortcode picker of any message field (`composer.pickers`). */
export const ShortcodePart = () => <ShortcodePicker target={useComposerField().field} />;
