import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { basename } from '@nota-bene/shared/paths';
import { projectFileUrl } from '@/files/kinds.ts';
import { useT } from '@/i18n/index.ts';
import { EdgeBackIcon, EdgeForwardIcon, FrameBackIcon, FrameForwardIcon, PauseIcon, PlayIcon } from '@/media/playerIcons.tsx';
import { isMac, withKeys } from '@/shell/keymap.ts';
import type { CutPlayer } from './engine.ts';
import { drawnSpan, fmtTime, ppsRange, rulerStep, ticksIn, type Block, type Lane } from './layout.ts';
import { poster } from './thumbs.ts';
import { applyCutKey } from './useCutKeys.ts';

const HEAD = 144; // the track headers' column, px
const STEP = 1.5; // one zoom button press
const dB = (g: number) => `${g > 0 ? '+' : g < 0 ? '−' : ''}${Math.abs(g)} dB`;

/**
 * The edit's tracks read-only (issue 407): a ruler, the lanes with their clips placed by time, zoom (buttons, Ctrl/⌘+wheel
 * around the pointer), and the preview's transport (issue 408): play, the clip-edge and frame steps, the time, and the
 * playhead that follows `player`, set by a click on the ruler or dragged there or by its line (scrubbing). While playing
 * the view scrolls to keep the playhead in sight. `problems`: the messages of a clip by its index in `clips`; such a clip
 * is outlined.
 */
export function Timeline({ player, lanes, blocks, end, frame, problems, missing, fileSrc, active, tools }: {
  player: CutPlayer;
  lanes: Lane[]; blocks: Block[]; end: number; frame: { width: number; height: number; fps: number } | null;
  problems: ReadonlyMap<number, string[]>; missing: ReadonlySet<string>; fileSrc: string; active: boolean;
  /** the toolbar's right end, after the size and rate (the Export control) */
  tools?: ReactNode;
}) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
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
      if (!e.ctrlKey && !e.metaKey) return;
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
  };

  // while playing, a playhead about to leave the view turns the page: it comes back near the left edge
  useEffect(() => player.subscribe(() => {
    const s = player.state();
    const el = scroller.current;
    if (!s.playing || !el) return;
    const w = el.clientWidth - HEAD;
    const x = s.t * ppsRef.current;
    if (w > 0 && (x < el.scrollLeft || x > el.scrollLeft + w - 24)) el.scrollLeft = Math.max(0, x - w * 0.1);
  }), [player]);
  const key = (code: string) => void applyCutKey(player, code);

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
      <div ref={scroller} data-timeline-scroll onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto bg-background">
        <div className="relative min-w-full" style={{ width: HEAD + width }}>
          <div className="sticky top-0 z-30 flex h-6 border-b border-border-soft bg-chrome">
            <div className="sticky left-0 z-40 flex-none border-r border-border-soft bg-chrome" style={{ width: HEAD }} />
            <div ref={ruler} data-ruler title={t('cutRulerTip')} className="relative flex-1 cursor-pointer touch-none select-none" {...drag}>
              {ticks.map((s) => (
                <span key={s} data-tick className="absolute top-0 h-full border-l border-border-soft pl-1 font-mono text-[0.625rem] leading-6 text-muted-foreground" style={{ left: s * pps }}>
                  {fmtTime(s, step < 1)}
                </span>
              ))}
              <Head player={player} pps={pps} className="pointer-events-none absolute bottom-0 -ml-1 h-0 w-0 border-x-4 border-t-[6px] border-x-transparent border-t-destructive" />
            </div>
          </div>
          {lanes.map((l) => (
            <div key={l.id} data-lane={l.id} className={`flex border-b border-border-soft ${l.kind === 'video' ? 'h-14' : 'h-10'}`}>
              <div data-track-head={l.id} className="sticky left-0 z-20 flex flex-none flex-col justify-center gap-0.5 border-r border-border-soft bg-chrome px-2 text-xs" style={{ width: HEAD }}>
                <span className="truncate text-foreground" title={l.name ?? l.id}>{l.name ?? t(l.kind === 'video' ? 'cutVideoN' : 'cutAudioN', l.n)}</span>
                <span className="flex gap-1 font-mono text-[0.625rem] text-muted-foreground">
                  {l.gain !== undefined && l.gain !== 0 && <span>{dB(l.gain)}</span>}
                  {l.mute && <span className="rounded bg-muted px-1">{t('cutMute')}</span>}
                  {l.solo && <span className="rounded bg-muted px-1">{t('cutSolo')}</span>}
                  {l.hidden && <span className="rounded bg-muted px-1">{t('cutHidden')}</span>}
                </span>
              </div>
              <div className="relative flex-1">
                {blocks.filter((b) => b.track === l.id).map((b) => (
                  <Clip key={b.i} b={b} lane={l} pps={pps} frame={frame} problems={problems.get(b.i)} gone={missing.has(b.src)} fileSrc={fileSrc} active={active} />
                ))}
              </div>
            </div>
          ))}
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
function Clip({ b, lane, pps, frame, problems, gone, fileSrc, active }: {
  b: Block; lane: Lane; pps: number; frame: { width: number; height: number } | null; problems: string[] | undefined; gone: boolean;
  fileSrc: string; active: boolean;
}) {
  const w = Math.max(2, b.len * pps);
  const bad = !!problems?.length;
  const url = projectFileUrl(b.src, fileSrc);
  // a thumbnail only where it has room, and never for a file that is not there
  const thumb = lane.kind === 'video' && !gone && w >= 48;
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref, active && thumb);
  const frameOf = usePoster(seen && thumb && !b.photo ? url : null, b.from || 0);
  const shown = seen && thumb ? (b.photo ? url : frameOf) : null;
  const title = [b.src, `${fmtTime(b.at, true)} – ${fmtTime(b.at + b.len, true)}`, ...(problems ?? [])].join('\n');
  const tint = lane.kind === 'video' ? 'border-link/60 bg-link/15' : 'border-success/60 bg-success/15';
  return (
    <div
      ref={ref} data-clip={b.id} data-bad={bad || undefined} title={title}
      className={`absolute inset-y-1 flex items-center gap-1 overflow-hidden rounded border text-xs ${tint} ${bad ? 'outline-2 outline-destructive' : ''} ${gone ? 'opacity-60' : ''}`}
      style={{ left: b.at * pps, width: w }}
    >
      {shown && <img src={shown} alt="" draggable={false} className="h-full flex-none bg-black object-cover" style={frame ? { aspectRatio: `${frame.width} / ${frame.height}` } : undefined} />}
      <span className={`min-w-0 truncate px-1 ${gone ? 'line-through' : ''}`}>{basename(b.src)}</span>
    </div>
  );
}
