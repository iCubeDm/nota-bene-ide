import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AUDIO, isPhotoSrc, validateCut, type Cut, type CutIssue } from '@nota-bene/shared/cut';
import { basename } from '@nota-bene/shared/paths';
import { projectFileUrl } from '@/files/kinds.ts';
import { useT } from '@/i18n/index.ts';
import { srcLength } from './durations.ts';
import { EditBar } from './EditBar.tsx';
import type { Editing } from './editing.ts';
import { CutPlayer } from './engine.ts';
import { drawable } from './layout.ts';
import { ExportControl } from './export/ExportControl.tsx';
import { Inspector } from './Inspector.tsx';
import { addClip, addTrack, deleteClips, duplicateClip, nudgeClip, splitAt, takes } from './ops.ts';
import { PlaceBox } from './PlaceBox.tsx';
import { Preview } from './Preview.tsx';
import { Timeline } from './Timeline.tsx';
import { useCutDoc } from './useCutDoc.ts';
import { useCutKeys } from './useCutKeys.ts';
import { useMissing } from './useMissing.ts';

/** A photo dropped on the timeline shows this long, seconds; a source whose length the browser cannot read too. */
const PHOTO_LEN = 5;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clipIndex = (path: string) => /^clips\[(\d+)\]/.exec(path)?.[1];

/**
 * A `*.nbcut.json` file as its preview (issue 408) over its timeline (read-only, issue 407). Whatever is wrong in it (not JSON, a validation problem, a
 * source not in the project) is listed above the timeline, which still draws what it can; the header's Source shows the
 * JSON. `path` (the edit's, project-relative) is given for an edit of the session's project: the toolbar then has Export
 * (issue 411), disabled while anything is wrong in the edit, since the server would refuse it. The preview plays a valid
 * edit (a missing source is black and silent); one with problems only moves the playhead. A valid edit of the session's
 * project is edited in place (issue 409, useCutDoc): the timeline's clips and tracks, the inspector and the selected
 * clip's frame on the preview change it, each change saved to the file and undoable.
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
  const [sel, setSel] = useState<string | null>(null);
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
  const selected = cut?.clips.find((c) => c.id === sel) ?? null;
  useEffect(() => { if (sel !== null && cut && !cut.clips.some((c) => c.id === sel)) setSel(null); }, [cut, sel]);
  const lens = useSrcLens(cut ? srcs : [], src);
  const commit = (next: Cut) => {
    setNotice(null);
    // every step stays a valid edit (the operations keep it so; this keeps a slip out of the file)
    if (!validateCut(next).ok || (cutRef.current && JSON.stringify(next) === JSON.stringify(cutRef.current))) return;
    doc.apply(next);
  };
  const split = () => {
    if (!cut) return;
    const r = splitAt(cut, player.time(), selected ? [selected.id] : []);
    if (r.ids.length) commit(r.cut);
  };
  const remove = () => { if (cut && selected) commit(deleteClips(cut, [selected.id])); };
  const duplicate = () => {
    if (!cut || !selected) return;
    const r = duplicateClip(cut, selected.id);
    if (r.id) { commit(r.cut); setSel(r.id); }
  };
  const addFile = async (file: string, track: string | null, at: number) => {
    const kind = AUDIO.test(file) ? 'audio' : 'video';
    const now = cutRef.current;
    if (!now || !takes(kind, file)) return setNotice(t('cutCannotAdd', basename(file)));
    const len = isPhotoSrc(file) ? PHOTO_LEN : (await srcLength(projectFileUrl(file, src))) ?? PHOTO_LEN;
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
    setSel(r.id);
  };
  const editing: Editing | undefined = cut ? {
    cut, sel, select: setSel, draft: setDraft, commit, lenOf: (s) => lens.get(s), addFile: (f, tr, at) => void addFile(f, tr, at),
  } : undefined;

  // the editor's keys: Delete/Backspace, S splits, ← → nudge the selected clip a frame (Shift: ten), Esc lets it go,
  // ⌘/Ctrl+Z undoes, ⇧⌘/Ctrl+Shift+Z redoes
  const editKey = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  editKey.current = (e) => {
    if (!cut) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && e.code === 'KeyZ') {
      if (e.shiftKey) doc.redo();
      else doc.undo();
      return true;
    }
    if (mod || e.altKey) return false;
    switch (e.code) {
      case 'Delete': case 'Backspace':
        if (!selected) return false;
        remove();
        return true;
      case 'KeyS':
        if (e.shiftKey) return false;
        if (!e.repeat) split();
        return true;
      case 'ArrowLeft': case 'ArrowRight':
        if (!selected) return false;
        commit(nudgeClip(cut, selected.id, (e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1)));
        return true;
      case 'Escape':
        if (!selected) return false;
        setSel(null);
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
            </div>
          )}
          {editing && (
            <EditBar
              doc={doc} sel={!!selected} onSplit={split} onDuplicate={duplicate} onDelete={remove} notice={notice}
              onAddTrack={(kind) => commit(addTrack(editing.cut, kind).cut)}
            />
          )}
          {(draw.lanes.length > 0 || editing) && (
            <Timeline
              player={player} lanes={draw.lanes} blocks={draw.blocks} end={draw.end} frame={frame} problems={problems} missing={missing} fileSrc={src} active={active}
              tools={path !== undefined && <ExportControl path={path} blocked={issues.length > 0 ? t('cutExportBlocked') : undefined} />}
              editing={editing}
            />
          )}
        </>
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
