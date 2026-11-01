import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '@/i18n/index.ts';
import { apiFetch } from '@/net/auth.ts';
import { useWrapLines } from '../wrap.ts';

type Draft = { text: string; base: string | null };

const draftKey = (path: string) => `nb.edit.${path}`;

function readDraft(path: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(path));
    return raw === null ? null : JSON.parse(raw) as Draft;
  } catch {
    return null;
  }
}
export const hasDraft = (path: string): boolean => readDraft(path) !== null;

function keepDraft(path: string, draft: Draft | null): void {
  try {
    if (draft) localStorage.setItem(draftKey(path), JSON.stringify(draft));
    else localStorage.removeItem(draftKey(path));
  } catch { /* no storage, or the file is too big for it: the edit lives as long as the tab */ }
}

const CHOICE = 'rounded px-2 py-0.5 text-foreground hover:bg-muted disabled:opacity-50';
const PRIMARY = 'rounded bg-primary px-2 py-0.5 text-primary-foreground disabled:opacity-50';

/**
 * A file by hand. What is typed and not saved stays in localStorage, so a closed tab or a reload keeps it. `base` is the version
 * the edit started from: the server refuses a save over anything newer, and only "overwrite" goes past that.
 */
export function FileEditor({ path, onClose }: { path: string; onClose: (saved: boolean) => void }) {
  const t = useT();
  const wrap = useWrapLines();
  const [text, setText] = useState<string | null>(null);
  /** what is on disk, as a text box sees it; null: unknown, a draft came first */
  const [orig, setOrig] = useState<string | null>(null);
  const base = useRef<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = text !== null && text !== orig;

  const fetchDisk = async () => {
    setProblem(null);
    try {
      const r = await apiFetch(`/edit?path=${encodeURIComponent(path)}`);
      if (!r.ok) return setProblem(r.status === 415 ? t('binary') : r.status === 413 ? t('tooLarge') : r.status === 404 ? t('fileGone') : `${r.status} ${r.statusText}`.trim());
      const j = await r.json() as { text: string; base: string };
      const shown = j.text.replace(/\r\n/g, '\n'); // a text box's value has no other line end
      base.current = j.base;
      setOrig(shown);
      setText(shown);
    } catch (e) {
      setProblem(String(e));
    }
  };
  useEffect(() => {
    const draft = readDraft(path);
    if (!draft) return void fetchDisk();
    base.current = draft.base;
    setText(draft.text);
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps -- once per file

  const edit = (next: string) => {
    setText(next);
    keepDraft(path, next === orig ? null : { text: next, base: base.current });
  };

  const save = async (overwrite: boolean) => {
    if (text === null || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await apiFetch('/edit', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, text, base: overwrite ? null : base.current }),
      });
      if (r.status === 409) return setConflict(true);
      if (!r.ok) {
        const error = (await r.json().catch(() => null) as { error?: string } | null)?.error;
        return setProblem(error === 'read-only' ? t('editReadOnly') : r.status === 404 ? t('fileGone') : r.status === 413 ? t('tooLarge') : `${r.status} ${r.statusText}`.trim());
      }
      keepDraft(path, null);
      onClose(true);
    } catch (e) {
      setProblem(String(e));
    } finally {
      setBusy(false);
    }
  };

  const discard = () => {
    keepDraft(path, null);
    onClose(false);
  };
  const takeDisk = () => {
    keepDraft(path, null);
    setConflict(false);
    void fetchDisk();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.code === 'KeyS' && (e.metaKey || e.ctrlKey || e.altKey)) {
      e.preventDefault();
      if (dirty) void save(false);
    } else if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const el = e.currentTarget, indent = /^\t/m.test(el.value) ? '\t' : '  ';
      // execCommand keeps the text box's undo; where there is none, the text still goes in
      if (!document.execCommand?.('insertText', false, indent)) {
        el.setRangeText(indent, el.selectionStart, el.selectionEnd, 'end');
        edit(el.value);
      }
    }
  };

  return (
    <div data-file-editor data-anchor-skip className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border-soft bg-chrome px-3 py-1 text-xs">
        <button type="button" title={`${t('editSave')} (Alt+S)`} disabled={!dirty || busy} onClick={() => void save(false)} className={PRIMARY}>{t('editSave')}</button>
        <button type="button" onClick={() => (dirty ? setAsking(true) : onClose(false))} className={CHOICE}>{t('editCancel')}</button>
        {asking && (
          <span className="flex items-center gap-1 text-muted-foreground">
            {t('editDiscardAsk')}
            <button type="button" onClick={discard} className={CHOICE}>{t('editDiscard')}</button>
            <button type="button" onClick={() => setAsking(false)} className={CHOICE}>{t('editKeep')}</button>
          </span>
        )}
        {conflict && (
          <span role="alert" className="flex items-center gap-1 text-warn">
            {t('editChanged')}
            <button type="button" onClick={() => { setConflict(false); void save(true); }} className={CHOICE}>{t('editOverwrite')}</button>
            <button type="button" onClick={takeDisk} className={CHOICE}>{t('editTakeDisk')}</button>
          </span>
        )}
        {problem && <span role="alert" className="text-destructive">{problem}</span>}
      </div>
      {text !== null && (
        <textarea
          aria-label={path} value={text} autoFocus spellCheck={false} wrap={wrap ? 'soft' : 'off'}
          onChange={(e) => edit(e.target.value)} onKeyDown={onKey}
          className="nb-code min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-xs leading-relaxed outline-none"
        />
      )}
    </div>
  );
}
