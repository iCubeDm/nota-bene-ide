import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isCutAnchor, type Comment, type CutAnchor } from '@nota-bene/shared';
import { AUDIO, isPhotoSrc, validateCut, type Cut, type CutIssue } from '@nota-bene/shared/cut';
import { basename } from '@nota-bene/shared/paths';
import { projectFileUrl } from '@/files/kinds.ts';
import { useT } from '@/i18n/index.ts';
import { CommentPopup, type PendingComment } from '@/comments/CommentPopup.tsx';
import { labelText } from '@/comments/labels.ts';
import { moveCutComment, selectComments } from '@/comments/slice.ts';
import { clearJump, selectJump } from '@/files/slice.ts';
import { mediaTime } from '@/media/markup/geometry.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { srcLength } from './durations.ts';
import { appendMedia } from './assemble.ts';
import { mediaLen } from './mediaLen.ts';
import { registerEditTarget, touchEditTarget } from './targets.ts';
import { EditBar } from './EditBar.tsx';
import type { Editing, Tool } from './editing.ts';
import { CutPlayer } from './engine.ts';
import { drawable } from './layout.ts';
import { ExportControl } from './export/ExportControl.tsx';
import { GroupInspector, Inspector } from './Inspector.tsx';
import { addClip, addTrack, deleteClips, duplicateClip, duplicateClips, moveClips, nudgeClip, splitAt, takes } from './ops.ts';
import { PlaceBox } from './PlaceBox.tsx';
import { Preview } from './Preview.tsx';
import { Timeline } from './Timeline.tsx';
import { useCutDoc } from './useCutDoc.ts';
import { useCutKeys } from './useCutKeys.ts';
import { useMissing } from './useMissing.ts';
import { setLiveCut } from './live.ts';
import { CUT_PROTOCOL, followAnchor, pinAnchor, timeOf } from './pin.ts';
import type { CutNote } from './Timeline.tsx';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clipIndex = (path: string) => /^clips\[(\d+)\]/.exec(path)?.[1];

/**
 * A `*.nbcut.json` file as its preview (issue 408) over its timeline (read-only, issue 407). Whatever is wrong in it (not JSON, a validation problem, a
 * source not in the project) is listed above the timeline, which still draws what it can; the header's Source shows the
 * JSON. `path` (the edit's, project-relative) is given for an edit of the session's project: the toolbar then has Export
 * (issue 411), disabled while anything is wrong in the edit, since the server would refuse it. The preview plays a valid
 * edit (a missing source is black and silent); one with problems only moves the playhead. A valid edit of the session's
 * project is edited in place (issue 409, useCutDoc): the timeline's clips and tracks, the inspector and the selected
 * clip's frame on the preview change it, each change saved to the file and undoable. Comments on it (issue 430): Comment
 * (M, for marker) pins one to the selected clip or the playhead's moment; their ticks and their cards seek there and select the clip,
 * and a pending one keeps to its clip as the clip moves or is trimmed. Tools and selections (issue 432): Select (V) and Blade
 * (C, cuts the clip under a click); any number of clips selected, moved, nudged, duplicated and deleted together.
 */
export function CutBody({ text, src, path, tabId, active }: { text: string; src: string; path?: string; tabId: string; active: boolean }) {
  const t = useT();
  const listId = useId();
  const parsed = useMemo((): { v: unknown } | { error: string } => {
    try {
      return { v: JSON.parse(text) as unknown };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [text]);
  const doc = useCutDoc({ text, path });
  // what a drag shows before it is committed
  const [draft, setDraft] = useState<Cut | null>(null);
  const [sel, setSel] = useState<readonly string[]>([]);
  const [tool, setTool] = useState<Tool>('select');
  const [notice, setNotice] = useState<string | null>(null);
  const v = draft ?? doc.cut ?? ('v' in parsed ? parsed.v : undefined);
  const check = useMemo(() => validateCut(v), [v]);
  const draw = useMemo(() => drawable(v), [v]);
  // every clip's source, placed or not: a missing file is worth knowing either way
  const clips = isObj(v) && Array.isArray(v.clips) ? v.clips : [];
  const srcs = clips.flatMap((c: unknown) => (isObj(c) && typeof c.src === 'string' && c.src ? [c.src] : []));
  const missing = useMissing('v' in parsed ? srcs : [], src, active);

  // one player for the tab's life; an edited file is handed to it, the playhead stays where it was
  const srcRef = useRef(src);
  srcRef.current = src;
  const [player] = useState(() => new CutPlayer({ url: (s) => projectFileUrl(s, srcRef.current) }));
  useEffect(() => () => player.dispose(), [player]);
  const playable = check.ok ? check.cut : null;
  useEffect(() => player.setCut(playable, draw.end), [player, playable, draw.end]);
  useEffect(() => player.setLive(active), [player, active]);
  const pane = useRef<HTMLDivElement>(null);

  // the editing: on the committed edit (a drag shows `draft` meanwhile)
  const cut = doc.cut;
  const cutRef = useRef(cut);
  cutRef.current = cut;
  // the next edit shown is this window's own change (issue 430: only those move the comments)
  const own = useRef(false);
  const undo = () => { if (doc.canUndo) { own.current = true; doc.undo(); } };
  const redo = () => { if (doc.canRedo) { own.current = true; doc.redo(); } };
  // a draft belongs to the edit it was built on: another one (a commit, a reload) shows as it is
  useEffect(() => setDraft(null), [cut]);
  // the selected clips as the edit has them; `selected` the one when there is one alone
  const chosen = cut ? cut.clips.filter((c) => sel.includes(c.id)) : [];
  const selected = chosen.length === 1 ? chosen[0]! : null;
  useEffect(() => {
    if (cut && sel.some((id) => !cut.clips.some((c) => c.id === id))) setSel(sel.filter((id) => cut.clips.some((c) => c.id === id)));
  }, [cut, sel]);
  const ids = chosen.map((c) => c.id);
  const lens = useSrcLens(cut ? srcs : [], src);
  const commit = (next: Cut) => {
    setNotice(null);
    // every step stays a valid edit (the operations keep it so; this keeps a slip out of the file)
    if (!validateCut(next).ok || (cutRef.current && JSON.stringify(next) === JSON.stringify(cutRef.current))) return;
    own.current = true;
    doc.apply(next);
  };
  const split = () => {
    if (!cut) return;
    const r = splitAt(cut, player.time(), ids);
    if (r.ids.length) commit(r.cut);
  };
  // the blade (issue 432): the clip under the click, or every clip under that time
  const blade = (t: number, clip: string | null, all: boolean) => {
    if (!cut || (!all && clip === null)) return;
    const r = splitAt(cut, t, all ? [] : [clip!]);
    if (r.ids.length) commit(r.cut);
  };
  const remove = () => { if (cut && ids.length) commit(deleteClips(cut, ids)); };
  const duplicate = () => {
    if (!cut || !ids.length) return;
    if (selected) {
      const r = duplicateClip(cut, selected.id);
      if (r.id) { commit(r.cut); setSel([r.id]); }
      return;
    }
    const r = duplicateClips(cut, ids);
    if (r.ids.length) { commit(r.cut); setSel(r.ids); }
  };
  // ← → on the selection: one clip to the nearest free place, several together or not at all
  const nudge = (frames: number) => {
    if (!cut) return;
    if (selected) return commit(nudgeClip(cut, selected.id, frames));
    const next = moveClips(cut, ids, frames / cut.fps);
    if (next) commit(next);
  };
  const addFile = async (file: string, track: string | null, at: number) => {
    const kind = AUDIO.test(file) ? 'audio' : 'video';
    const now = cutRef.current;
    if (!now || !takes(kind, file)) return setNotice(t('cutCannotAdd', basename(file)));
    const len = await mediaLen(file, src);
    let base = cutRef.current ?? now;
    let on = track !== null && base.tracks.find((x) => x.id === track)?.kind === kind ? track : null;
    if (on === null) {
      const r = addTrack(base, kind);
      base = r.cut;
      on = r.id;
    }
    const r = addClip(base, { track: on, src: file, at, len });
    if (!r) return setNotice(t('cutCannotAdd', basename(file)));
    commit(r.cut);
    setSel([r.id]);
  };
  // Add to edit from the Files tree (issue 426): the files after the end of the first track of each one's kind, one step
  const addFiles = async (files: readonly string[]) => {
    const items = await Promise.all(files.map(async (f) => ({ src: f, len: await mediaLen(f, src) })));
    const now = cutRef.current;
    const r = now && appendMedia(now, items);
    const skipped = r ? r.skipped : files;
    setNotice(null);
    if (r) {
      commit(r.cut);
      setSel(r.ids);
    }
    if (skipped.length) setNotice(t('cutCannotAdd', skipped.map((f) => basename(f)).join(', ')));
  };
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  const canAdd = cut !== null && path !== undefined;
  useEffect(() => {
    if (!canAdd || path === undefined) return;
    return registerEditTarget({ path, add: (f) => addFilesRef.current(f) });
  }, [canAdd, path]);
  useEffect(() => { if (active && path !== undefined) touchEditTarget(path); }, [active, path]);
  // comments on this edit (issue 430): where each is now, its clip followed by id
  const dispatch = useAppDispatch();
  const protocol = useAppSelector((s) => s.controls.protocol);
  const all = useAppSelector(selectComments);
  const mine = useMemo(() => (path === undefined ? [] : all.filter((c): c is Comment & { anchor: CutAnchor } =>
    isCutAnchor(c.anchor) && c.anchor.source.path === path && c.anchor.source.ref === undefined)), [all, path]);
  const [popup, setPopup] = useState<PendingComment | null>(null);
  // a pending comment keeps to its clip after a change of this window's own (an edit, undo, redo): never after the edit as
  // loaded, a reload of the file or an edit of the comment from elsewhere, so two windows never re-pin each other's echoes
  const mineRef = useRef(mine);
  mineRef.current = mine;
  useEffect(() => {
    if (!cut || !own.current) return;
    own.current = false;
    for (const c of mineRef.current) {
      const next = c.status === 'pending' ? followAnchor(c.anchor, cut) : null;
      if (next) dispatch(moveCutComment(c.id, next));
    }
  }, [cut, dispatch]);
  // the edit as it stands, for the cards and the batch (a clip no longer in it, a moment trimmed out): known while this view shows it
  useEffect(() => {
    if (path === undefined) return;
    setLiveCut(path, undefined, cut);
  }, [cut, path]);
  useEffect(() => () => { if (path !== undefined) setLiveCut(path, undefined, null); }, [path]);
  const notes: CutNote[] = mine.map((c) => {
    const time = (cut && timeOf(c.anchor, cut)) ?? c.anchor.time;
    const note = c.text.trim() || (c.label ? labelText(c.label) : '');
    return { id: c.id, time, ...(c.anchor.clip ? { clip: c.anchor.clip.id } : {}), title: `${mediaTime(time)} · ${note}`, sent: c.status === 'sent' };
  });
  const goTo = (id: string) => {
    const c = mine.find((x) => x.id === id);
    if (!c) return;
    player.pause();
    player.seek((cut && timeOf(c.anchor, cut)) ?? c.anchor.time);
    const k = c.anchor.clip?.id;
    if (k !== undefined && cut?.clips.some((x) => x.id === k)) setSel([k]);
  };
  // the card's "jump to source" (FileView leaves a comment on the timeline to this view)
  const jump = useAppSelector(selectJump);
  useEffect(() => {
    if (!active || path === undefined || jump?.path !== path || jump.src !== src || jump.ref !== undefined) return;
    if (!mine.some((c) => c.id === jump.id)) return;
    dispatch(clearJump());
    goTo(jump.id);
  });
  const canComment = protocol >= CUT_PROTOCOL && path !== undefined;
  const comment = () => {
    if (!cut || path === undefined) return;
    const anchor = pinAnchor(cut, { kind: 'file', path }, player.time(), selected?.id ?? null);
    // the popup opens by the clip, or by the playhead for a moment of the timeline
    const el = pane.current?.querySelector(anchor.clip ? `[data-clip="${CSS.escape(anchor.clip.id)}"]` : '[data-playhead]');
    const r = (el ?? pane.current)?.getBoundingClientRect() ?? new DOMRect();
    setPopup({ anchor, rect: new DOMRect(r.x, r.y, r.width, r.height) });
  };

  const editing: Editing | undefined = cut ? {
    cut, sel, select: setSel, tool, blade, draft: setDraft, commit, lenOf: (s) => lens.get(s), addFile: (f, tr, at) => void addFile(f, tr, at),
  } : undefined;

  // the editor's keys: Delete/Backspace, S splits, ← → nudge the selection a frame (Shift: ten), V and C the tools, Esc back
  // to Select or (with Select) lets the selection go, ⌘/Ctrl+Z undoes, ⇧⌘/Ctrl+Shift+Z redoes
  const editKey = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  editKey.current = (e) => {
    if (!cut) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && e.code === 'KeyZ') {
      if (e.shiftKey) redo();
      else undo();
      return true;
    }
    if (mod || e.altKey) return false;
    switch (e.code) {
      case 'Delete': case 'Backspace':
        if (!ids.length) return false;
        remove();
        return true;
      case 'KeyS':
        if (e.shiftKey) return false;
        if (!e.repeat) split();
        return true;
      case 'ArrowLeft': case 'ArrowRight':
        if (!ids.length) return false;
        nudge((e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
        return true;
      case 'KeyV': case 'KeyC':
        if (e.shiftKey) return false;
        setTool(e.code === 'KeyV' ? 'select' : 'blade');
        return true;
      case 'KeyM':
        if (e.shiftKey || !canComment) return false;
        if (!e.repeat) comment();
        return true;
      case 'Escape':
        // Esc in the Files tree closes the tree (FileTree.tsx)
        if (document.activeElement?.closest('#tree-sheet')) return false;
        if (tool !== 'select') { setTool('select'); return true; }
        if (!ids.length) return false;
        setSel([]);
        return true;
    }
    return false;
  };
  useCutKeys(player, active, pane, editKey);

  const issues: CutIssue[] = [...(check.ok ? [] : check.errors)];
  clips.forEach((c: unknown, i) => {
    if (isObj(c) && typeof c.src === 'string' && missing.has(c.src)) {
      issues.push({ path: `clips[${i}].src`, code: 'missing', ...(typeof c.id === 'string' && { clip: c.id }) });
    }
  });
  const problems = new Map<number, string[]>();
  for (const x of issues) {
    const i = clipIndex(x.path);
    if (i !== undefined) problems.set(Number(i), [...(problems.get(Number(i)) ?? []), `${x.path}: ${t('cutIssue', x.code)}`]);
  }
  const frame = isObj(v) && [v.width, v.height, v.fps].every((n) => typeof n === 'number' && n > 0)
    ? { width: v.width as number, height: v.height as number, fps: v.fps as number }
    : null;

  return (
    <div ref={pane} data-pane={tabId} hidden={!active} className="relative min-h-0 flex-1 flex-col bg-background [&:not([hidden])]:flex">
      {'error' in parsed ? (
        <p className="p-4 text-sm text-destructive">{t('cutBadJson', parsed.error)}</p>
      ) : (
        <>
          {issues.length > 0 && (
            <div className="max-h-40 flex-none overflow-auto border-b border-border-soft px-3 py-2 text-xs">
              <p id={listId} className="mb-1 font-medium text-destructive">{t('cutProblems', issues.length)}</p>
              <ul aria-labelledby={listId} className="space-y-0.5">
                {issues.map((x, i) => (
                  <li key={i} className="text-muted-foreground">
                    {x.path && <code className="mr-1.5 font-mono text-foreground">{x.path}</code>}
                    {t('cutIssue', x.code)}
                    {x.clip !== undefined && ` · ${t('cutClipOf', x.clip)}`}
                    {x.clip === undefined && x.track !== undefined && ` · ${t('cutTrackOf', x.track)}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {draw.blocks.length === 0 && issues.length === 0 && (
            <p className="flex-none px-3 py-2 text-sm text-muted-foreground">{t('cutNoClips')}</p>
          )}
          {(draw.lanes.length > 0 || editing) && frame && (
            <div className="flex min-h-24 flex-[3_1_0%]">
              <Preview player={player} frame={frame} blocked={check.ok ? undefined : t('cutPreviewBlocked')}>
                {editing && selected && editing.cut.tracks.find((x) => x.id === selected.track)?.kind === 'video' && (
                  <PlaceBox cut={editing.cut} clip={(draft ?? editing.cut).clips.find((c) => c.id === selected.id) ?? selected} draft={setDraft} commit={commit} />
                )}
              </Preview>
              {editing && selected && <Inspector key={selected.id} cut={editing.cut} clip={selected} commit={commit} />}
              {editing && chosen.length > 1 && <GroupInspector key={ids.join('\n')} cut={editing.cut} clips={chosen} commit={commit} />}
            </div>
          )}
          {editing && (
            <EditBar
              doc={{ ...doc, undo, redo }} sel={ids.length > 0} onSplit={split} onDuplicate={duplicate} onDelete={remove} notice={notice}
              onComment={canComment ? comment : undefined} tool={tool} onTool={setTool}
            />
          )}
          {(draw.lanes.length > 0 || editing) && (
            <Timeline
              player={player} lanes={draw.lanes} blocks={draw.blocks} end={draw.end} frame={frame} problems={problems} missing={missing} fileSrc={src} active={active}
              tools={path !== undefined && <ExportControl path={path} blocked={issues.length > 0 ? t('cutExportBlocked') : undefined} />}
              editing={editing} notes={notes} onNote={(n) => goTo(n.id)}
            />
          )}
        </>
      )}
      {popup && createPortal(
        <div className="relative z-30" hidden={!active}>
          <CommentPopup key={`${popup.rect.x}:${popup.rect.y}`} pending={popup} onClose={() => setPopup(null)} hidden={!active} />
        </div>,
        document.body,
      )}
    </div>
  );
}

/** The sources' lengths once the browser has read them (durations.ts), by source. */
function useSrcLens(srcs: string[], fileSrc: string): ReadonlyMap<string, number> {
  const key = [...new Set(srcs)].filter((s) => !isPhotoSrc(s)).sort().join('\n');
  const [lens, setLens] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    if (!key) return;
    let live = true;
    for (const s of key.split('\n')) {
      void srcLength(projectFileUrl(s, fileSrc)).then((n) => {
        if (live && n !== null) setLens((m) => (m.get(s) === n ? m : new Map(m).set(s, n)));
      });
    }
    return () => { live = false; };
  }, [key, fileSrc]);
  return lens;
}
