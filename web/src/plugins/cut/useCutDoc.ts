import { useCallback, useEffect, useRef, useState } from 'react';
import { validateCut, type Cut } from '@nota-bene/shared/cut';
import { connections, routes, send } from '@/sdk';
import { cutChanges, isNoChange, type CutChanges } from './changes.ts';
import { commit, redo as redoStep, start, undo as undoStep, type History } from './history.ts';

/** ms after the last edit before it is written. */
export const SAVE_DELAY = 400;
/** The edit as the editor writes it: two-space JSON and a final newline. */
export const serialize = (c: Cut): string => `${JSON.stringify(c, null, 2)}\n`;

type DocStatus = 'saved' | 'unsaved' | 'saving' | 'conflict' | 'error';
export type CutDoc = {
  /** the edit being edited; null while it cannot be (not yet read, invalid, another source, no /edit) */
  cut: Cut | null;
  status: DocStatus;
  /** why the last save failed */
  problem: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** `next` as a new step of the history, saved after SAVE_DELAY */
  apply: (next: Cut) => void;
  undo: () => void;
  redo: () => void;
  /** in a conflict: write this edit over the file's newer version */
  overwrite: () => Promise<void>;
  /** in a conflict: drop the unsaved edits and take the file's version */
  takeDisk: () => Promise<void>;
  /** what the last reload from the file changed against the edit shown before it (issue 412): a new object for each
   *  reload that changed a clip; null until one did. Never the first read, nor this editor's own saves read back. */
  changes: CutChanges | null;
};

// the server writes a save with the file's own line ends (fileEdit.ts withLineEnds): a CRLF file comes back CRLF
const lf = (text: string): string => text.replace(/\r\n/g, '\n');

const parse = (text: string): Cut | null => {
  try {
    const r = validateCut(JSON.parse(text));
    return r.ok ? r.cut : null;
  } catch {
    return null;
  }
};

/**
 * An edit's file as the editor's state (issue 409), through the file editor's route (`/edit`: the text with its version,
 * a save refused over a newer version). `text`: the file as the file view last read it; each new read checks the
 * version on disk: a change from outside (the agent) reloads the edit when nothing is unsaved, and turns into a
 * conflict otherwise, as in the file editor: nothing is overwritten without the user's word. Edits are saved
 * SAVE_DELAY after the last one; undo and redo are this editor's, and start again from a reloaded file.
 * `path` undefined (a view of another source) or a server without `/edit`: nothing is editable.
 */
export function useCutDoc({ text, path }: { text: string; path: string | undefined }): CutDoc {
  const [hist, setHist] = useState<History<Cut> | null>(null);
  // the edit as the file has it: what is shown is unsaved while it is another object
  const [saved, setSaved] = useState<Cut | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [changes, setChanges] = useState<CutChanges | null>(null);
  // the file as last read or written, with its version
  const disk = useRef<{ text: string; base: string } | null>(null);
  // counts writes started and ended: a read that overlapped one may hold the older text
  const writes = useRef(0);
  const live = useRef({ hist, saved, conflict });
  live.current = { hist, saved, conflict };
  const dirty = hist !== null && hist.now !== saved;

  // a read of the file that is not what this editor wrote: against the edit shown, what it changed in the clips
  const adopt = useCallback((t: string, base: string) => {
    disk.current = { text: t, base };
    const cut = parse(t);
    const shown = live.current.hist?.now;
    if (shown && cut) {
      const d = cutChanges(shown, cut);
      if (!isNoChange(d)) setChanges(d);
    }
    setHist(cut ? start(cut) : null);
    setSaved(cut);
    setConflict(false);
    setProblem(null);
  }, []);

  const readDisk = useCallback(async (force: boolean) => {
    if (path === undefined) return;
    const w = writes.current;
    let j: { text: string; base: string };
    try {
      const r = await connections.current().fetch(routes.edit(path));
      if (!r.ok) return;
      j = await r.json() as { text: string; base: string };
      if (typeof j.text !== 'string' || typeof j.base !== 'string') return;
    } catch {
      return; // no version, no editing: the view stays as it is
    }
    if (w !== writes.current) return;
    if (!force && disk.current && lf(disk.current.text) === lf(j.text)) return void (disk.current.base = j.base);
    const { hist: h, saved: s } = live.current;
    if (!force && h !== null && h.now !== s) return setConflict(true);
    adopt(j.text, j.base);
  }, [path, adopt]);
  useEffect(() => { void readDisk(false); }, [text, readDisk]);

  // one save at a time: each one starts after the one before it, from the version that one wrote
  const inflight = useRef<Promise<void> | null>(null);
  const save = useCallback((overwrite: boolean, keepalive = false): Promise<void> => {
    const run = async () => {
      const h = live.current.hist;
      if (path === undefined || !h || !disk.current) return;
      const now = h.now;
      const body = serialize(now);
      if (!overwrite && lf(disk.current.text) === lf(body)) return void setSaved(now); // written already (a flush)
      writes.current++;
      setSaving(true);
      try {
        const r = await send(routes.edit(), { path, text: body, base: overwrite ? null : disk.current.base }, { keepalive });
        if (r.status === 409) return setConflict(true);
        if (!r.ok) {
          const error = (await r.json().catch(() => null) as { error?: string } | null)?.error;
          return setProblem(error ?? `${r.status} ${r.statusText}`.trim());
        }
        const j = await r.json() as { base: string };
        disk.current = { text: body, base: j.base };
        setSaved(now);
        setConflict(false);
        setProblem(null);
      } catch (e) {
        setProblem(e instanceof Error ? e.message : String(e));
      } finally {
        writes.current++;
        setSaving(false);
      }
    };
    const p = (inflight.current ?? Promise.resolve()).then(run);
    inflight.current = p;
    void p.finally(() => { if (inflight.current === p) inflight.current = null; });
    return p;
  }, [path]);

  // a pause after the last edit writes it; not while in conflict, nor again after a failure until the next edit
  useEffect(() => {
    if (!dirty || conflict || saving || problem !== null) return;
    const id = setTimeout(() => void save(false), SAVE_DELAY);
    return () => clearTimeout(id);
  }, [hist, dirty, conflict, saving, problem, save]);

  // the tab closed, or the page left (reload, window closed: nothing unmounts then), within the pause: the last edit
  // is still written, after a save in flight and over the version it wrote; never over a conflict
  const flush = useRef<() => void>(() => {});
  flush.current = () => {
    const { hist: h, saved: s, conflict: c } = live.current;
    if (path === undefined || !h || h.now === s || c) return;
    void save(false, true);
  };
  useEffect(() => {
    const onHide = () => flush.current();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      flush.current();
    };
  }, []);

  const apply = useCallback((next: Cut) => {
    setProblem(null);
    setHist((h) => (h ? commit(h, next) : h));
  }, []);
  const undo = useCallback(() => setHist((h) => (h ? undoStep(h) : h)), []);
  const redo = useCallback(() => setHist((h) => (h ? redoStep(h) : h)), []);

  const editable = path !== undefined && hist !== null;
  return {
    cut: editable ? hist.now : null,
    status: conflict ? 'conflict' : problem !== null ? 'error' : saving ? 'saving' : dirty ? 'unsaved' : 'saved',
    problem,
    canUndo: !!hist?.past.length,
    canRedo: !!hist?.future.length,
    apply, undo, redo,
    overwrite: () => save(true),
    takeDisk: () => readDisk(true),
    changes,
  };
}
