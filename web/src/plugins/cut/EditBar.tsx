import type { ReactNode } from 'react';
import { useT, isMac, withKeys } from '@/sdk';
import type { Tool } from './editing.ts';
import type { CutDoc } from './useCutDoc.ts';

const BTN = 'rounded px-1.5 py-0.5 text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent';
const CHOICE = 'rounded px-2 py-0.5 text-foreground hover:bg-muted';

/** The tools' icons (issue 463): 24×24 outlines in the lucide style, as the player's and the markup bar's. */
const icon = (children: ReactNode, size = 14) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={size > 14 ? '-m-0.5 block' : 'block'}>
    {children}
  </svg>
);
/** Select: the pointer arrow */
const SelectIcon = () => icon(<path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.13 1.58a2 2 0 0 0-1.43 1.43l-1.58 6.13a.5.5 0 0 1-.95.06z" />);
/**
 * Blade: a double-edged razor blade running top-left to bottom-right, notched at its ends, its slot with the round hole
 * (filled: an outline of it does not read at 14 px). Drawn 4 px larger: the arrow fills its box, a thin blade does not
 * (its negative margin keeps the button the Select one's size)
 */
const BladeIcon = () => icon(
  <path
    transform="rotate(40 12 12)" fill="currentColor" stroke="none" fillRule="evenodd"
    d="M3.5 7H20.5A1.5 1.5 0 0 1 22 8.5V10.5A1.5 1.5 0 0 0 22 13.5V15.5A1.5 1.5 0 0 1 20.5 17H3.5A1.5 1.5 0 0 1 2 15.5V13.5A1.5 1.5 0 0 0 2 10.5V8.5A1.5 1.5 0 0 1 3.5 7ZM7 11.1H10.1A2.3 2.3 0 0 1 13.9 11.1H17A0.9 0.9 0 0 1 17 12.9H13.9A2.3 2.3 0 0 1 10.1 12.9H7A0.9 0.9 0 0 1 7 11.1Z"
  />,
  18,
);
/** Split: scissors */
const SplitIcon = () => icon(<><circle cx="6" cy="6" r="3" /><path d="M8.12 8.12 12 12" /><path d="M20 4 8.12 15.88" /><circle cx="6" cy="18" r="3" /><path d="M14.8 14.8 20 20" /></>);
/** Duplicate: two overlapping sheets */
const DuplicateIcon = () => icon(<><rect x="8" y="8" width="14" height="14" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>);
/** Delete: a trash can */
const DeleteIcon = () => icon(<><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2M10 11v6M14 11v6" /></>);

/**
 * The editor's tools (issue 409), each tooltip naming its key: the timeline's tool (issue 432: Select or Blade, the active
 * one pressed), undo and redo, split at the playhead, duplicate and delete the selected clips (the new tracks are in the
 * track column, issue 432), a comment on the clip or the playhead's moment (issue 430; absent
 * `onComment`: the server would refuse it), and how the file stands (saved, saving, a conflict with a
 * version written meanwhile, as the file editor offers it: overwrite, or take the file's version).
 */
export function EditBar({ doc, sel, onSplit, onDuplicate, onDelete, onComment, notice, tool, onTool }: {
  doc: CutDoc; sel: boolean; onSplit: () => void; onDuplicate: () => void; onDelete: () => void;
  onComment?: () => void; notice: string | null; tool: Tool; onTool: (t: Tool) => void;
}) {
  const t = useT();
  const mod = isMac() ? '⌘' : 'Ctrl+';
  const shift = isMac() ? '⇧' : 'Shift+';
  const b = (label: string, keys: string | null, glyph: ReactNode, onClick: () => void, disabled = false) => {
    const tip = keys ? withKeys(label, keys) : label;
    return <button type="button" aria-label={tip} title={tip} disabled={disabled} onClick={onClick} className={BTN}>{glyph}</button>;
  };
  const pick = (which: Tool, label: string, key: string, glyph: ReactNode) => {
    const tip = withKeys(label, key);
    return (
      <button type="button" aria-label={tip} title={tip} aria-pressed={tool === which} onClick={() => onTool(which)}
        className={`${BTN} ${tool === which ? 'bg-nb-accent/20 text-nb-accent hover:bg-nb-accent/20' : ''}`}>{glyph}</button>
    );
  };
  const status = doc.status;
  return (
    <div data-cut-tools className="flex min-h-7 flex-none flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-border-soft bg-chrome px-3 py-0.5 text-xs text-muted-foreground">
      {pick('select', t('cutToolSelect'), 'V', <SelectIcon />)}
      {pick('blade', t('cutToolBlade'), 'C', <BladeIcon />)}
      <span className="mx-1 h-4 border-l border-border-soft" />
      {b(t('cutUndo'), `${mod}Z`, <span className="text-sm leading-none">↶</span>, doc.undo, !doc.canUndo)}
      {b(t('cutRedo'), `${shift}${mod}Z`, <span className="text-sm leading-none">↷</span>, doc.redo, !doc.canRedo)}
      <span className="mx-1 h-4 border-l border-border-soft" />
      {b(t('cutSplit'), 'S', <SplitIcon />, onSplit)}
      {b(t('cutDuplicate'), null, <DuplicateIcon />, onDuplicate, !sel)}
      {b(t('cutDelete'), 'Delete', <DeleteIcon />, onDelete, !sel)}
      {onComment && <span className="mx-1 h-4 border-l border-border-soft" />}
      {onComment && b(t('cutComment'), 'M', t('cutCommentShort'), onComment)}
      <span className="flex-1" />
      {notice && <span role="status" className="text-warn">{notice}</span>}
      {status === 'conflict' ? (
        <span role="alert" className="flex items-center gap-1 text-warn">
          {t('editChanged')}
          <button type="button" onClick={() => void doc.overwrite()} className={CHOICE}>{t('editOverwrite')}</button>
          <button type="button" onClick={() => void doc.takeDisk()} className={CHOICE}>{t('editTakeDisk')}</button>
        </span>
      ) : status === 'error' ? (
        <span role="alert" className="text-destructive">{t('cutSaveFailed', doc.problem ?? '')}</span>
      ) : (
        <span data-cut-status={status}>{t(status === 'saved' ? 'cutSaved' : status === 'saving' ? 'cutSaving' : 'cutUnsaved')}</span>
      )}
    </div>
  );
}
