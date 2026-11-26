import type { EditorView } from '@codemirror/view';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { t, type I18nKey } from '../../i18n/index.ts';
import { isMac, modKey, withKeys } from '../../shell/keymap.ts';
import { Svg } from '../icons.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.tsx';
import { codeBlock, link, toggleInline, toggleLines } from './format.ts';

interface Tool { label: I18nKey; key?: string; shift?: boolean; run: (v: EditorView) => boolean; icon: ReactNode }

// lucide's text-format icons
const TOOLS: Tool[][] = [[
  { label: 'fmtBold', key: 'B', run: (v) => toggleInline(v, '**'), icon: <path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8" /> },
  { label: 'fmtItalic', key: 'I', run: (v) => toggleInline(v, '*'), icon: <path d="M19 4h-9M14 20H5M15 4 9 20" /> },
  { label: 'fmtStrike', key: 'X', shift: true, run: (v) => toggleInline(v, '~~'), icon: <path d="M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16" /> },
  { label: 'fmtCode', key: 'E', run: (v) => toggleInline(v, '`'), icon: <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" /> },
  { label: 'fmtLink', key: 'K', run: link, icon: <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /> },
], [
  { label: 'fmtBlock', run: codeBlock, icon: <><path d="m10 9-3 3 3 3M14 15l3-3-3-3" /><rect x="3" y="3" width="18" height="18" rx="2" /></> },
  { label: 'fmtList', run: (v) => toggleLines(v, '- '), icon: <path d="M3 6h.01M3 12h.01M3 18h.01M8 6h13M8 12h13M8 18h13" /> },
  { label: 'fmtQuote', run: (v) => toggleLines(v, '> '), icon: <path d="M17 6H3M21 12H8M21 18H8M3 12v6" /> },
]];

const BAR_GAP = 6;
const BAR_HEIGHT = 32;

/**
 * The format bar over a selection in the field (issue 727): the inline formats with their keys, then the block ones.
 * It follows the selection through every change of the field (`watchers`: the host's value too) and any scroll, goes
 * when the selection collapses or the field loses focus, and keeps the field's selection when pressed.
 */
export function FormatBar({ view, watchers }: { view: RefObject<EditorView | null>; watchers: Set<() => void> }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const place = () => {
      const sel = v.state.selection.main;
      if (sel.empty || !v.hasFocus) return setAt(null);
      const start = v.coordsAtPos(sel.from), end = v.coordsAtPos(sel.to);
      const above = (start?.top ?? 0) - BAR_HEIGHT - BAR_GAP;
      setAt({ left: start?.left ?? 0, top: above >= 0 ? above : (end?.bottom ?? 0) + BAR_GAP });
    };
    const hide = () => setAt(null);
    watchers.add(place);
    v.contentDOM.addEventListener('blur', hide);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      watchers.delete(place);
      v.contentDOM.removeEventListener('blur', hide);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [view, watchers]);
  const v = view.current;
  if (!at || !v) return null;
  const keys = (tool: Tool) => (tool.key ? `${modKey()}${tool.shift ? (isMac() ? '⇧' : 'Shift+') : ''}${tool.key}` : '');
  return createPortal(
    <div role="toolbar" aria-label={t('fmtBar')} style={{ left: at.left, top: at.top }}
      className="fixed z-50 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 shadow-md">
      {TOOLS.map((group, i) => [
        i > 0 && <span key={`gap${i}`} className="mx-0.5 h-5 w-px bg-border" />,
        ...group.map((tool) => (
          <Tooltip key={tool.label}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t(tool.label)}
                // the field keeps its selection: the press never takes the focus
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { tool.run(v); v.focus(); }}
                className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Svg size={15}>{tool.icon}</Svg>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{tool.key ? withKeys(t(tool.label), keys(tool)) : t(tool.label)}</TooltipContent>
          </Tooltip>
        )),
      ])}
    </div>,
    document.body,
  );
}
