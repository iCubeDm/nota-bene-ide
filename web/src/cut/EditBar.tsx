import type { ReactNode } from 'react';
import { useT } from '@/i18n/index.ts';
import { isMac, withKeys } from '@/shell/keymap.ts';
import type { Tool } from './editing.ts';
import type { CutDoc } from './useCutDoc.ts';

const BTN = 'rounded px-1.5 py-0.5 text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent';
const CHOICE = 'rounded px-2 py-0.5 text-foreground hover:bg-muted';

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
  const pick = (which: Tool, label: string, key: string, glyph: string) => {
    const tip = withKeys(label, key);
    return (
      <button type="button" aria-label={tip} title={tip} aria-pressed={tool === which} onClick={() => onTool(which)}
        className={`${BTN} ${tool === which ? 'bg-primary/25' : ''}`}>{glyph}</button>
    );
  };
  const status = doc.status;
  return (
    <div data-cut-tools className="flex min-h-7 flex-none flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-border-soft bg-chrome px-3 py-0.5 text-xs text-muted-foreground">
      {pick('select', t('cutToolSelect'), 'V', t('cutToolSelectShort'))}
      {pick('blade', t('cutToolBlade'), 'C', t('cutToolBladeShort'))}
      <span className="mx-1 h-4 border-l border-border-soft" />
      {b(t('cutUndo'), `${mod}Z`, <span className="text-sm leading-none">↶</span>, doc.undo, !doc.canUndo)}
      {b(t('cutRedo'), `${shift}${mod}Z`, <span className="text-sm leading-none">↷</span>, doc.redo, !doc.canRedo)}
      <span className="mx-1 h-4 border-l border-border-soft" />
      {b(t('cutSplit'), 'S', t('cutSplitShort'), onSplit)}
      {b(t('cutDuplicate'), null, t('cutDuplicateShort'), onDuplicate, !sel)}
      {b(t('cutDelete'), 'Delete', t('cutDeleteShort'), onDelete, !sel)}
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
