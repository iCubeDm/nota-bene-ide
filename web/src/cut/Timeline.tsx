import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type DragEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { clipLength, type Cut } from '@nota-bene/shared/cut';
import { basename } from '@nota-bene/shared/paths';
import { projectFileUrl } from '@/files/kinds.ts';
import { useT } from '@/i18n/index.ts';
import { EdgeBackIcon, EdgeForwardIcon, FrameBackIcon, FrameForwardIcon, PauseIcon, PlayIcon } from '@/media/playerIcons.tsx';
import { isMac, withKeys } from '@/shell/keymap.ts';
import { PATH_MIME } from './drag.ts';
import type { Editing } from './editing.ts';
import type { CutPlayer } from './engine.ts';
import { dB, FadeHandle, FadeSlopes, GainLine, usePeaks, Wave } from './ClipSound.tsx';
import { addTrack, dragGain, laneShift, moveClip, moveClips, setFade, setGain, snapMove, snapPoints, snapTime, trimEnd, trimStart } from './ops.ts';
import { TrackHead } from './TrackHead.tsx';
import { drawnSpan, fmtTime, ppsRange, rulerStep, ticksIn, type Block, type Lane } from './layout.ts';
import { poster } from './thumbs.ts';
import { applyCutKey } from './useCutKeys.ts';

const HEAD = 144; // the track headers' column, px
const STEP = 1.5; // one zoom button press

/**
 * The edit's tracks read-only (issue 407): a ruler, the lanes with their clips placed by time, zoom (buttons, Ctrl/⌘+wheel
 * around the pointer), and the preview's transport (issue 408): play, the clip-edge and frame steps, the time, and the
 * playhead that follows `player`, set by a click on the ruler or dragged there or by its line (scrubbing). While playing
 * the view scrolls to keep the playhead in sight. `problems`: the messages of a clip by its index in `clips`; such a clip
 * is outlined. `editing` (issue 409): a clip is selected by a click, moved by a drag (to another track of its kind too),
 * trimmed by its edges, snapping to the playhead, 0 and the other clips' edges (Alt: no snapping); the track headers
 * rename, mute, solo, hide, reorder and remove; a project file dropped from the Files tree becomes a clip. `notes` (issue
 * 430): the comments, a tick on their clip (on the ruler for a moment of the timeline or a clip that is gone), the note on
 * hover; a click is `onNote`. A clip's sound (issue 431): the waveform of its used part where it is in view, and while
 * editing its gain line (dragged up or down, Shift: fine) and its fades' handles at its top corners (dragged inward).
 * Tools and selections (issue 432): with Select, Shift- or ⌘/Ctrl-click adds or removes a clip and a rectangle dragged on
 * empty space selects what it touches (Shift: adds), a selection moves together; with Blade, a click cuts the clip under
 * it there, snapped as edges are (Shift: every track; the line shows where on hover). The new tracks' buttons end each
 * kind's lanes in the track column.
 */
export function Timeline({ player, lanes, blocks, end, frame, problems, missing, fileSrc, active, tools, editing, notes = [], onNote }: {
  player: CutPlayer;
  lanes: Lane[]; blocks: Block[]; end: number; frame: { width: number; height: number; fps: number } | null;
  problems: ReadonlyMap<number, string[]>; missing: ReadonlySet<string>; fileSrc: string; active: boolean;
  /** the toolbar's right end, after the size and rate (the Export control) */
  tools?: ReactNode;
  editing?: Editing;
  notes?: CutNote[];
  onNote?: (n: CutNote) => void;
}) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const manual = useRef(false); // the user scrolled while playing: the view stops following the playhead
  const [zoomed, setPps] = useState(40);
  const span = drawnSpan(end);
  const range = ppsRange(span);
  const clamp = (p: number) => Math.min(range.max, Math.max(range.min, p));
  const pps = clamp(zoomed); // an edit that grew may narrow the zoom's limits
  const width = span * pps;
  // the lanes' width in view (the scroller less the headers): what fits, what the buttons zoom around
  const lanesWidth = () => (scroller.current?.clientWidth ?? 0) - HEAD;

  // the first time the timeline has a size, the whole edit fits (16 px: room for a vertical scrollbar)
  const fitted = useRef(false);
  const fit = () => {
    const w = lanesWidth() - 16;
    if (w > 0) setPps(clamp(w / span));
    return w > 0;
  };
  useLayoutEffect(() => {
    if (active && !fitted.current) fitted.current = fit();
  });

  // Ctrl/⌘+wheel zooms around the pointer: the time under it stays under it (React's wheel listener is passive)
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const keepLeft = useRef<number | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return void (manual.current = true);
      e.preventDefault();
      const x = e.clientX - el.getBoundingClientRect().left - HEAD; // pointer over the lanes
      const at = (el.scrollLeft + x) / ppsRef.current;
      const { min, max } = rangeRef.current;
      const next = Math.min(max, Math.max(min, ppsRef.current * Math.exp(-e.deltaY * 0.002)));
      if (next === ppsRef.current) return; // at the limit: no render would take a scroll position
      keepLeft.current = Math.max(0, at * next - x);
      fitted.current = true;
      setPps(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  useLayoutEffect(() => {
    if (keepLeft.current === null || !scroller.current) return;
    scroller.current.scrollLeft = keepLeft.current;
    keepLeft.current = null;
  }, [pps]);
  // the buttons zoom around the middle of the view
  const zoom = (f: number) => {
    fitted.current = true;
    const next = clamp(pps * f);
    if (next === pps) return;
    const half = Math.max(0, lanesWidth()) / 2;
    keepLeft.current = Math.max(0, ((scroller.current?.scrollLeft ?? 0) + half) / pps * next - half);
    setPps(next);
  };

  // the ruler draws the ticks in view and a view's width either side: an hour at the closest zoom is thousands
  const [view, setView] = useState({ left: 0, width: 0 });
  const onScroll = () => {
    const el = scroller.current;
    if (el) setView({ left: el.scrollLeft, width: el.clientWidth });
  };
  useLayoutEffect(onScroll, [pps, active]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const seen = Math.max(view.width, 1000);
  const step = rulerStep(pps);
  const ticks = ticksIn(step, span, (view.left - seen) / pps, (view.left + 2 * seen) / pps);
  const mod = isMac() ? '⌘' : 'Ctrl';
  const btn = 'rounded px-1.5 hover:bg-muted hover:text-foreground';

  // scrubbing: a press on the ruler or the playhead's line, then the drag; playback holds and is silent meanwhile
  const ruler = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const timeAt = (x: number) => Math.max(0, (x - (ruler.current?.getBoundingClientRect().left ?? 0)) / pps);
  const stop = () => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    player.scrub(false);
  };
  const drag = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      scrubbing.current = true;
      player.scrub(true);
      player.seek(timeAt(e.clientX));
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => { if (scrubbing.current) player.seek(timeAt(e.clientX)); },
    onPointerUp: stop,
    onPointerCancel: stop,
    onLostPointerCapture: stop,
  };
  // a timeline gone mid-drag must not leave the player held and silent
  useEffect(() => () => { if (scrubbing.current) player.scrub(false); }, [player]);

  // while playing (and on a seek while paused), a playhead about to leave the view turns the page: it comes back near the left edge. A scroll of the
  // user's own (wheel, the scrollbar: a press on the scroller itself) stops that until the next play or seek
  const last = useRef(player.state());
  useEffect(() => player.subscribe(() => {
    const s = player.state();
    const sought = s.seeks !== last.current.seeks;
    if (sought || (s.playing && !last.current.playing)) manual.current = false;
    last.current = s;
    const el = scroller.current;
    // paused, a seek that left the view (a comment's tick or card, a key) brings the playhead back into it; a scrub stays in it
    if (!el || manual.current || (!s.playing && (!sought || scrubbing.current))) return;
    const w = el.clientWidth - HEAD;
    const x = s.t * ppsRef.current;
    if (w > 0 && (x < el.scrollLeft || x > el.scrollLeft + w - 24)) el.scrollLeft = Math.max(0, x - w * 0.1);
  }), [player]);
  const key = (code: string) => void applyCutKey(player, code);
  // the blade's time under the pointer: snapped as an edge is to 0, the playhead and the clips' edges but `except`'s (Alt: not)
  const bladeAt = (x: number, alt: boolean, except: readonly string[]) => {
    const at = timeAt(x);
    return alt || !editing ? at : snapTime(at, snapPoints(editing.cut, player.time(), except), SNAP_PX / pps);
  };
  const clipDrag = useClipDrag(editing, pps, player, scroller, bladeAt);
  // the blade's line on hover (issue 432): in the clip's lane, in every lane with Shift
  const [cutLine, setCutLine] = useState<{ lane: string | null; t: number } | null>(null);
  const hoverBlade = (e: PointerEvent<HTMLElement>, lane: string) => {
    if (editing?.tool !== 'blade') return;
    const id = (e.target as HTMLElement).closest('[data-clip]')?.getAttribute('data-clip') ?? null;
    if (id === null && !e.shiftKey) return setCutLine(null);
    setCutLine({ lane: e.shiftKey ? null : lane, t: bladeAt(e.clientX, e.altKey, id === null ? [] : [id]) });
  };
  // a press on a lane's empty space: with the blade and Shift, a cut across the tracks; with Select a rectangle that
  // selects every clip it touches (Shift: added to the selection); a click alone lets the selection go
  const inner = useRef<HTMLDivElement>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const pressLane = (e: PointerEvent<HTMLElement>) => {
    if (!editing || e.target !== e.currentTarget || e.button !== 0) return;
    if (editing.tool === 'blade') {
      if (e.shiftKey) editing.blade(bladeAt(e.clientX, e.altKey, []), null, true);
      return;
    }
    e.preventDefault();
    const ed = editing;
    const keep = e.shiftKey ? [...ed.sel] : [];
    if (!e.shiftKey) ed.select([]);
    const x0 = e.clientX, y0 = e.clientY;
    let on = false;
    const move = (m: globalThis.PointerEvent) => {
      if (!on && Math.max(Math.abs(m.clientX - x0), Math.abs(m.clientY - y0)) < DRAG_PX) return;
      on = true;
      const [xa, xb] = [Math.min(x0, m.clientX), Math.max(x0, m.clientX)];
      const [ya, yb] = [Math.min(y0, m.clientY), Math.max(y0, m.clientY)];
      const r = inner.current?.getBoundingClientRect();
      setBox({ left: xa - (r?.left ?? 0), top: ya - (r?.top ?? 0), width: xb - xa, height: yb - ya });
      const hit = new Set<string>();
      for (const el of scroller.current?.querySelectorAll<HTMLElement>('[data-lane-body]') ?? []) {
        const lr = el.getBoundingClientRect();
        if (lr.height > 0 && lr.top < yb && lr.bottom > ya && el.dataset.laneBody) hit.add(el.dataset.laneBody);
      }
      const t0 = timeAt(xa), t1 = timeAt(xb);
      const got = blocksRef.current.filter((b) => hit.has(b.track) && b.at <= t1 && b.at + b.len >= t0).map((b) => b.id);
      ed.select([...keep, ...got.filter((id) => !keep.includes(id))]);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setBox(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  // a project file from the tree: on a lane at the time under the pointer, below the lanes onto a new track
  const dropOver = (e: DragEvent<HTMLElement>) => {
    if (!editing || ![...e.dataTransfer.types].includes(PATH_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const drop = (e: DragEvent<HTMLElement>, track: string | null) => {
    const path = editing && e.dataTransfer.getData(PATH_MIME);
    if (!path) return;
    e.preventDefault();
    const left = track === null ? (ruler.current?.getBoundingClientRect().left ?? 0) : e.currentTarget.getBoundingClientRect().left;
    const at = (e.clientX - left) / pps;
    editing.addFile(path, track, Number.isFinite(at) ? Math.max(0, at) : 0);
  };
  // a comment's tick: in its clip's lane, or on the ruler (a moment, or a clip no longer drawn)
  const laneOf = (n: CutNote) => (n.clip === undefined ? undefined : blocks.find((b) => b.id === n.clip)?.track);
  const tick = (n: CutNote) => <NoteTick key={n.id} n={n} pps={pps} onNote={onNote} />;
  const lane = (l: Lane) => (
    <div key={l.id} data-lane={l.id} className={`flex border-b border-border-soft ${l.kind === 'video' ? 'h-14' : 'h-10'}`}>
      {editing ? <TrackHead lane={l} cut={editing.cut} commit={editing.commit} width={HEAD} /> : (
      <div data-track-head={l.id} className="sticky left-0 z-20 flex flex-none flex-col justify-center gap-0.5 border-r border-border-soft bg-chrome px-2 text-xs" style={{ width: HEAD }}>
        <span className="truncate text-foreground" title={l.name ?? l.id}>{l.name ?? t(l.kind === 'video' ? 'cutVideoN' : 'cutAudioN', l.n)}</span>
        <span className="flex gap-1 font-mono text-[0.625rem] text-muted-foreground">
          {l.gain !== undefined && l.gain !== 0 && <span>{dB(l.gain)}</span>}
          {l.mute && <span className="rounded bg-muted px-1">{t('cutMute')}</span>}
          {l.solo && <span className="rounded bg-muted px-1">{t('cutSolo')}</span>}
          {l.hidden && <span className="rounded bg-muted px-1">{t('cutHidden')}</span>}
        </span>
      </div>
      )}
      <div
        data-lane-body={l.id} className="relative flex-1"
        onPointerDown={pressLane}
        onPointerMove={(e) => hoverBlade(e, l.id)} onPointerLeave={() => setCutLine(null)}
        onDragOver={dropOver} onDrop={(e) => drop(e, l.id)}
      >
        {blocks.filter((b) => b.track === l.id).map((b) => (
          <Clip
            key={b.i} b={b} lane={l} pps={pps} frame={frame} problems={problems.get(b.i)} gone={missing.has(b.src)} fileSrc={fileSrc} active={active}
            selected={editing?.sel.includes(b.id)} drag={editing ? clipDrag : undefined} view={{ from: (view.left - seen) / pps, to: (view.left + 2 * seen) / pps }}
          />
        ))}
        {notes.filter((n) => laneOf(n) === l.id).map(tick)}
        {editing?.tool === 'blade' && cutLine && (cutLine.lane === null || cutLine.lane === l.id) && (
          <div data-blade-line className="pointer-events-none absolute inset-y-0 z-[4] w-px bg-warn" style={{ left: cutLine.t * pps }} />
        )}
      </div>
    </div>
  );


  return (
    <div data-timeline data-pps={pps} className="flex min-h-0 flex-[2_1_0%] flex-col">
      <div className="flex min-h-8 flex-none flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-soft bg-chrome px-3 py-0.5 font-mono text-[0.71875rem] text-muted-foreground">
        <button type="button" aria-label={t('cutZoomOut', mod)} title={t('cutZoomOut', mod)} onClick={() => zoom(1 / STEP)} className={btn}>−</button>
        <button type="button" aria-label={t('cutZoomIn', mod)} title={t('cutZoomIn', mod)} onClick={() => zoom(STEP)} className={btn}>+</button>
        <button type="button" aria-label={t('cutZoomFit')} title={t('cutZoomFit')} onClick={fit} className={btn}>↔</button>
        <Transport player={player} onKey={key} />
        <Clock player={player} end={end} />
        <span className="flex-1" />
        {frame && <span>{t('cutFrame', frame.width, frame.height, frame.fps)}</span>}
        {tools && <div className="font-sans text-foreground">{tools}</div>}
      </div>
      <div
        ref={scroller} data-timeline-scroll onScroll={onScroll}
        onPointerDown={(e) => { if (e.target === e.currentTarget) manual.current = true; }} className="relative min-h-0 flex-1 overflow-auto bg-background">
        <div ref={inner} className="relative min-w-full" style={{ width: HEAD + width }}>
          <div className="sticky top-0 z-30 flex h-6 border-b border-border-soft bg-chrome">
            <div className="sticky left-0 z-40 flex-none border-r border-border-soft bg-chrome" style={{ width: HEAD }} />
            <div ref={ruler} data-ruler title={t('cutRulerTip')} className="relative flex-1 cursor-pointer touch-none select-none" {...drag}>
              {ticks.map((s) => (
                <span key={s} data-tick className="absolute top-0 h-full border-l border-border-soft pl-1 font-mono text-[0.625rem] leading-6 text-muted-foreground" style={{ left: s * pps }}>
                  {fmtTime(s, step < 1)}
                </span>
              ))}
              {notes.filter((n) => laneOf(n) === undefined).map(tick)}
              <Head player={player} pps={pps} className="pointer-events-none absolute bottom-0 -ml-1 h-0 w-0 border-x-4 border-t-[6px] border-x-transparent border-t-destructive" />
            </div>
          </div>
          {lanes.filter((l) => l.kind === 'video').map(lane)}
          {editing && <AddTrack kind="video" editing={editing} width={HEAD} />}
          {lanes.filter((l) => l.kind === 'audio').map(lane)}
          {editing && <AddTrack kind="audio" editing={editing} width={HEAD} />}
          {editing && (
            <div data-cut-drop onDragOver={dropOver} onDrop={(e) => drop(e, null)} className="flex h-10 items-center border-b border-dashed border-border-soft text-xs text-muted-foreground">
              <span className="sticky left-0 px-3">{t('cutDropNew')}</span>
            </div>
          )}
          {box && <div data-marquee className="pointer-events-none absolute z-40 border border-primary bg-primary/10" style={box} />}
          <div className="pointer-events-none absolute inset-y-0 z-10" style={{ left: HEAD }}>
            <Head player={player} pps={pps} data-playhead className="absolute inset-y-0 w-px bg-destructive">
              <div title={t('cutPlayheadTip')} className="pointer-events-auto absolute inset-y-0 -left-1 w-2 cursor-ew-resize touch-none" {...drag} />
            </Head>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A new track's button (issue 432), in the track column at the end of its kind's lanes. */
function AddTrack({ kind, editing, width }: { kind: 'video' | 'audio'; editing: Editing; width: number }) {
  const t = useT();
  const label = t(kind === 'video' ? 'cutAddVideo' : 'cutAddAudio');
  return (
    <div data-track-add={kind} className="flex h-6 border-b border-border-soft">
      <div className="sticky left-0 z-20 flex flex-none items-center border-r border-border-soft bg-chrome px-1" style={{ width }}>
        <button
          type="button" aria-label={label} title={label} onClick={() => editing.commit(addTrack(editing.cut, kind).cut)}
          className="rounded px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >{t(kind === 'video' ? 'cutAddVideoShort' : 'cutAddAudioShort')}</button>
      </div>
    </div>
  );
}

/** A comment on the timeline (issue 430): where it is now, its clip (absent: a moment of the timeline), its hover text. */
export type CutNote = { id: string; time: number; clip?: string; title: string; sent: boolean };

/** A comment's tick: the note on hover, a click is `onNote` (seek there, select the clip); a press never scrubs or drags. */
function NoteTick({ n, pps, onNote }: { n: CutNote; pps: number; onNote?: (n: CutNote) => void }) {
  return (
    <button
      type="button" data-cut-note={n.id} title={n.title} aria-label={n.title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onNote?.(n); }}
      className="absolute inset-y-0 z-[3] flex w-2 -translate-x-1/2 cursor-pointer items-start justify-center"
      style={{ left: n.time * pps }}
    >
      <span className="mt-0.5 h-3 w-[3px] rounded-sm bg-[var(--nb-accent)]" style={{ opacity: n.sent ? 0.45 : 1 }} />
    </button>
  );
}

// the parts that move with the clock re-render on their own, not the whole timeline on each frame
const usePlayerState = (p: CutPlayer) => useSyncExternalStore(p.subscribe, p.state);

function Head({ player, pps, children, ...rest }: { player: CutPlayer; pps: number; className: string; children?: ReactNode; 'data-playhead'?: boolean }) {
  const { t } = usePlayerState(player);
  return <div {...rest} style={{ left: t * pps }}>{children}</div>;
}

function Clock({ player, end }: { player: CutPlayer; end: number }) {
  const { t } = usePlayerState(player);
  return <span data-cut-time className="text-foreground tabular-nums">{fmtTime(t, true)} / {fmtTime(end, true)}</span>;
}

/** Play and pause, the clip edges and the frame steps: the keys' buttons (useCutKeys), each tooltip naming its key. */
function Transport({ player, onKey }: { player: CutPlayer; onKey: (code: string) => void }) {
  const t = useT();
  const { playing, ready } = usePlayerState(player);
  const b = 'grid size-6 place-items-center rounded hover:bg-muted hover:text-foreground disabled:opacity-40 [&>svg]:size-3.5';
  const button = (label: string, code: string, icon: ReactNode) => (
    <button type="button" aria-label={label} title={label} disabled={!ready} onClick={() => onKey(code)} className={b}>{icon}</button>
  );
  return (
    <span className="flex items-center text-foreground">
      {button(withKeys(t('cutPrevEdge'), '↑'), 'ArrowUp', <EdgeBackIcon />)}
      {button(withKeys(t('cutFrameBack'), ','), 'Comma', <FrameBackIcon />)}
      {button(withKeys(t(playing ? 'cutPause' : 'cutPlay'), 'Space, K'), 'Space', playing ? <PauseIcon /> : <PlayIcon />)}
      {button(withKeys(t('cutFrameFwd'), '.'), 'Period', <FrameForwardIcon />)}
      {button(withKeys(t('cutNextEdge'), '↓'), 'ArrowDown', <EdgeForwardIcon />)}
    </span>
  );
}

/** Whether `ref` has come into the timeline's view while `on` (the tab shown): once in, it stays in. */
function useSeen(ref: RefObject<HTMLElement | null>, on: boolean): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!on || seen || !el) return;
    if (typeof IntersectionObserver === 'undefined') return void setSeen(true);
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setSeen(true); }, {
      root: el.closest('[data-timeline-scroll]'), rootMargin: '0px 50%',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, on, seen]);
  return seen;
}

/** A video's frame at `at` as an image URL (shared, thumbs.ts) once `url` is given; null until then. */
function usePoster(url: string | null, at: number): string | null {
  const [got, setGot] = useState<{ key: string; src: string | null } | null>(null);
  const key = `${at}\n${url}`;
  useEffect(() => {
    if (url === null) return;
    let live = true;
    void poster(url, at).then((src) => { if (live) setGot({ key, src }); });
    return () => { live = false; };
  }, [url, at, key]);
  return got?.key === key ? got.src : null;
}

/** One clip: its file name, a thumbnail on a video track (the photo; a video's first used frame) once it is in view,
 *  its problems outlined; at least 2 px wide, however short. */
function Clip({ b, lane, pps, frame, problems, gone, fileSrc, active, selected, drag, view }: {
  b: Block; lane: Lane; pps: number; frame: { width: number; height: number } | null; problems: string[] | undefined; gone: boolean;
  fileSrc: string; active: boolean; selected?: boolean; drag?: ClipDrag;
  /** the timeline's seconds around the view: the waveform is drawn there */
  view: { from: number; to: number };
}) {
  const t = useT();
  const w = Math.max(2, b.len * pps);
  const bad = !!problems?.length;
  const url = projectFileUrl(b.src, fileSrc);
  // a thumbnail only where it has room, and never for a file that is not there
  const thumb = lane.kind === 'video' && !gone && w >= 48;
  const ref = useRef<HTMLDivElement>(null);
  const sound = !b.photo;
  // once in view, the thumbnail and the waveform load
  const seen = useSeen(ref, active && (thumb || (sound && !gone)));
  const frameOf = usePoster(seen && thumb && !b.photo ? url : null, b.from || 0);
  const shown = seen && thumb ? (b.photo ? url : frameOf) : null;
  // the sound (issue 431): the waveform drawn around the view, in steps of WAVE_STEP px so a scroll seldom redraws it
  const wave = usePeaks(seen && sound && !gone ? b.src : null, fileSrc);
  const peaks = wave && 'peaks' in wave ? wave.peaks : null;
  // a source known to have no sound (a video without it) has no gain to set
  const mute = !!wave && 'none' in wave && wave.none === 'no-audio';
  const x0 = Math.max(0, Math.floor((view.from - b.at) * pps / WAVE_STEP) * WAVE_STEP);
  const x1 = Math.min(w, Math.ceil((view.to - b.at) * pps / WAVE_STEP) * WAVE_STEP);
  const handles = !!drag && w >= 24;
  const title = [b.src, `${fmtTime(b.at, true)} – ${fmtTime(b.at + b.len, true)}`, ...(problems ?? []), ...(drag ? [t(drag.blade ? 'cutBladeTip' : 'cutClipTip')] : [])].join('\n');
  const tint = lane.kind === 'video' ? 'border-link/60 bg-link/15' : 'border-success/60 bg-success/15';
  return (
    <div
      ref={ref} data-clip={b.id} data-bad={bad || undefined} data-selected={selected || undefined} title={title}
      className={`absolute inset-y-1 flex items-center gap-1 overflow-hidden rounded border text-xs ${tint} ${bad ? 'outline-2 outline-destructive' : ''} ${gone ? 'opacity-60' : ''} ${selected ? 'z-[1] ring-2 ring-primary' : ''} ${drag ? `touch-none select-none ${drag.blade ? 'cursor-crosshair [&_*]:pointer-events-none' : 'cursor-grab'}` : ''}`}
      style={{ left: b.at * pps, width: w }}
      {...(drag && drag.handlers(b.id, 'move'))}
    >
      {peaks && <Wave b={b} peaks={peaks} pps={pps} x0={x0} x1={x1} band={lane.kind === 'video'} />}
      <FadeSlopes b={b} pps={pps} w={w} />
      {drag && sound && !mute && <GainLine gain={b.gain ?? 0} press={drag.handlers(b.id, 'gain')} value={drag.live?.id === b.id && drag.live.grip === 'gain'} />}
      {handles && (['in', 'out'] as const).map((edge) => (
        <FadeHandle key={edge} edge={edge} b={b} pps={pps} w={w} press={drag.handlers(b.id, edge === 'in' ? 'fadeIn' : 'fadeOut')} />
      ))}
      {drag && (['start', 'end'] as const).map((edge) => (
        <span
          key={edge} data-trim={edge} title={t(edge === 'start' ? 'cutTrimStart' : 'cutTrimEnd')}
          className={`absolute inset-y-0 z-[2] w-1.5 cursor-ew-resize hover:bg-primary/40 ${edge === 'start' ? 'left-0' : 'right-0'}`}
          {...drag.handlers(b.id, edge)}
        />
      ))}
      {shown && <img src={shown} alt="" draggable={false} className="h-full flex-none bg-black object-cover" style={frame ? { aspectRatio: `${frame.width} / ${frame.height}` } : undefined} />}
      <span className={`relative min-w-0 truncate px-1 ${gone ? 'line-through' : ''}`}>{basename(b.src)}</span>
    </div>
  );
}

type Grip = 'move' | 'start' | 'end' | 'gain' | 'fadeIn' | 'fadeOut';
type ClipDrag = {
  handlers: (id: string, grip: Grip) => { onPointerDown: (e: PointerEvent<HTMLElement>) => void };
  /** the blade is the tool: a press cuts, the clip's grips are not there for the pointer */
  blade: boolean;
  /** the clip and grip being dragged, once it moved */
  live: { id: string; grip: Grip } | null;
};
// px within which a dragged edge snaps; px a press must travel to be a drag rather than a click
const SNAP_PX = 8;
const DRAG_PX = 3;
// the waveform's drawn part grows and moves in steps this wide, px
const WAVE_STEP = 512;
type Pointer = { clientX: number; clientY: number; altKey: boolean; shiftKey: boolean };

/**
 * A clip's drag: from the committed edit at the press, each move shows the result (`draft`), the release commits it.
 * The body moves the clip (the lane under the pointer takes it when it is of the clip's kind), an edge trims it, the gain
 * line sets its gain (Shift: fine steps, from where it is when Shift changes; a drag from it that starts sideways moves
 * the clip instead) and a fade's handle its fade. The
 * moves are the window's: a clip that changes lanes is a new element, and the drag must go on. An edit that changed
 * under the drag (a reload of the agent's version) ends it: a change built on the older edit is never committed.
 * Issue 432: Shift- or ⌘/Ctrl-press on a clip's body adds it to the selection or takes it out; a clip of a selection of
 * several moves them all (moveClips: refused, shown back where they were, while any would overlap), a click on it alone
 * selects it alone; its edges, gain line and fade handles act on it alone, the selection kept. With the blade a press
 * cuts the clip there (`bladeAt`, Shift: every track).
 */
function useClipDrag(
  ed: Editing | undefined, pps: number, player: CutPlayer, scroller: RefObject<HTMLElement | null>,
  bladeAt: (x: number, alt: boolean, except: readonly string[]) => number,
): ClipDrag {
  const edRef = useRef(ed);
  edRef.current = ed;
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const [live, setLive] = useState<{ id: string; grip: Grip } | null>(null);
  const laneAt = (y: number): string | undefined => {
    for (const el of scroller.current?.querySelectorAll<HTMLElement>('[data-lane-body]') ?? []) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && y >= r.top && y < r.bottom) return el.dataset.laneBody;
    }
  };
  return {
    live,
    blade: ed?.tool === 'blade',
    handlers: (id, grip0) => ({
      onPointerDown: (e) => {
        let grip = grip0;
        const ed0 = edRef.current;
        if (!ed0 || e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault(); // no text selection, no native drag
        if (ed0.tool === 'blade') return ed0.blade(bladeAt(e.clientX, e.altKey, [id]), id, e.shiftKey);
        if (grip0 === 'move' && (e.shiftKey || e.metaKey || e.ctrlKey)) {
          return ed0.select(ed0.sel.includes(id) ? ed0.sel.filter((x) => x !== id) : [...ed0.sel, id]);
        }
        const c = ed0.cut.clips.find((x) => x.id === id);
        if (!c) return;
        const base = ed0.cut;
        // a press on a clip of the selection keeps it: the body moves them all, the other grips act on this one
        const group = ed0.sel.includes(id) ? ed0.sel.filter((x) => base.clips.some((k) => k.id === x)) : [id];
        if (!ed0.sel.includes(id)) ed0.select([id]);
        stop.current?.();
        let moved = false;
        const x0 = e.clientX;
        // the gain line: from the gain at the press, or where it was when Shift last changed
        let g0 = c.gain ?? 0;
        let y0 = e.clientY;
        let fine = e.shiftKey;
        const h = (e.currentTarget.closest('[data-clip]') ?? e.currentTarget).getBoundingClientRect().height;
        const fade0 = grip === 'fadeIn' ? c.fadeIn ?? 0 : c.fadeOut ?? 0;
        const at0 = c.at;
        const end0 = c.at + clipLength(c);
        let out: Cut | null = null;
        // the edit changed under the drag (the agent's version reloaded): the drag is over, nothing of it is kept
        const stale = (cur: Editing | undefined): cur is undefined => !cur || cur.cut !== base;
        const move = (m: Pointer) => {
          const cur = edRef.current;
          if (stale(cur)) return void stop.current?.();
          if (grip === 'gain' && !out) {
            // the first movement decides: up or down sets the gain, sideways moves the clip
            const dx = Math.abs(m.clientX - x0);
            const dy = Math.abs(m.clientY - y0);
            if (Math.max(dx, dy) < DRAG_PX) return;
            if (dx > dy) grip = 'move';
          }
          if (grip === 'gain') {
            if (m.shiftKey !== fine) {
              g0 = out?.clips.find((x) => x.id === id)?.gain ?? g0;
              y0 = m.clientY;
              fine = m.shiftKey;
            }
            out = setGain(base, id, dragGain(g0, m.clientY - y0, h, fine));
            setLive({ id, grip });
            return cur.draft(out);
          }
          const lane = grip === 'move' ? laneAt(m.clientY) ?? c.track : c.track;
          if (!moved && Math.abs(m.clientX - x0) < DRAG_PX && lane === c.track) return;
          moved = true;
          const p = ppsRef.current;
          const dt = (m.clientX - x0) / p;
          if (grip === 'move' && group.length > 1) {
            // the pressed clip snaps; the rest keep their distance from it. Refused: the committed edit shows, nothing moved
            const pts = m.altKey ? [] : snapPoints(base, player.time(), group);
            const at = snapMove(at0 + dt, end0 - at0, pts, SNAP_PX / p);
            const shift = laneShift(base, c.track, lane);
            out = shift && moveClips(base, group, at - at0, shift);
            return cur.draft(out);
          }
          if (grip === 'fadeIn' || grip === 'fadeOut') {
            // inward: right for the fade-in, left for the fade-out
            out = setFade(base, id, grip === 'fadeIn' ? 'in' : 'out', fade0 + (grip === 'fadeIn' ? dt : -dt));
            setLive({ id, grip });
            return cur.draft(out);
          }
          const pts = m.altKey ? [] : snapPoints(base, player.time(), [id]);
          const tol = SNAP_PX / p;
          out = grip === 'move' ? moveClip(base, id, snapMove(at0 + dt, end0 - at0, pts, tol), lane)
            : grip === 'start' ? trimStart(base, id, snapTime(at0 + dt, pts, tol))
            : trimEnd(base, id, snapTime(end0 + dt, pts, tol), cur.lenOf(c.src));
          cur.draft(out);
        };
        const up = () => {
          stop.current?.();
          const cur = edRef.current;
          if (!cur) return;
          if (out && !stale(cur)) cur.commit(out);
          // a click on a clip of a selection, no drag: that clip alone
          else if (!moved && grip0 === 'move' && group.length > 1 && !stale(cur)) cur.select([id]);
          cur.draft(null);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        stop.current = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          stop.current = null;
          setLive(null);
        };
      },
    }),
  };
}
