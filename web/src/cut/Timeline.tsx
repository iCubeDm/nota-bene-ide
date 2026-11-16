import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { basename } from '@nota-bene/shared/paths';
import { projectFileUrl } from '@/files/kinds.ts';
import { useT } from '@/i18n/index.ts';
import { isMac } from '@/shell/keymap.ts';
import { drawnSpan, fmtTime, ppsRange, rulerStep, ticksIn, type Block, type Lane } from './layout.ts';
import { poster } from './thumbs.ts';

const HEAD = 144; // the track headers' column, px
const STEP = 1.5; // one zoom button press
const dB = (g: number) => `${g > 0 ? '+' : g < 0 ? '−' : ''}${Math.abs(g)} dB`;

/**
 * The edit's tracks read-only (issue 407): a ruler, the lanes with their clips placed by time, zoom (buttons, Ctrl/⌘+wheel
 * around the pointer) and the playhead a click on the ruler sets. Playback comes with the preview (issue 408).
 * `problems`: the messages of a clip by its index in `clips`; such a clip is outlined.
 */
export function Timeline({ lanes, blocks, end, frame, problems, missing, fileSrc, active, tools }: {
  lanes: Lane[]; blocks: Block[]; end: number; frame: { width: number; height: number; fps: number } | null;
  problems: ReadonlyMap<number, string[]>; missing: ReadonlySet<string>; fileSrc: string; active: boolean;
  /** the toolbar's right end, after the size and rate (the Export control) */
  tools?: ReactNode;
}) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const [zoomed, setPps] = useState(40);
  const [head, setHead] = useState(0);
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

  return (
    <div data-timeline data-pps={pps} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-8 flex-none flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-soft bg-chrome px-3 py-0.5 font-mono text-[0.71875rem] text-muted-foreground">
        <button type="button" aria-label={t('cutZoomOut', mod)} title={t('cutZoomOut', mod)} onClick={() => zoom(1 / STEP)} className={btn}>−</button>
        <button type="button" aria-label={t('cutZoomIn', mod)} title={t('cutZoomIn', mod)} onClick={() => zoom(STEP)} className={btn}>+</button>
        <button type="button" aria-label={t('cutZoomFit')} title={t('cutZoomFit')} onClick={fit} className={btn}>↔</button>
        <span className="text-foreground">{fmtTime(head, true)} / {fmtTime(end, true)}</span>
        <span className="flex-1" />
        {frame && <span>{t('cutFrame', frame.width, frame.height, frame.fps)}</span>}
        {tools && <div className="font-sans text-foreground">{tools}</div>}
      </div>
      <div ref={scroller} data-timeline-scroll onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto bg-background">
        <div className="relative min-w-full" style={{ width: HEAD + width }}>
          <div className="sticky top-0 z-30 flex h-6 border-b border-border-soft bg-chrome">
            <div className="sticky left-0 z-40 flex-none border-r border-border-soft bg-chrome" style={{ width: HEAD }} />
            <div
              data-ruler title={t('cutRulerTip')} className="relative flex-1 cursor-pointer select-none"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                setHead(Math.max(0, (e.clientX - e.currentTarget.getBoundingClientRect().left) / pps));
              }}
            >
              {ticks.map((s) => (
                <span key={s} data-tick className="absolute top-0 h-full border-l border-border-soft pl-1 font-mono text-[0.625rem] leading-6 text-muted-foreground" style={{ left: s * pps }}>
                  {fmtTime(s, step < 1)}
                </span>
              ))}
              <span className="pointer-events-none absolute bottom-0 -ml-1 h-0 w-0 border-x-4 border-t-[6px] border-x-transparent border-t-destructive" style={{ left: head * pps }} />
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
            <div data-playhead className="absolute inset-y-0 w-px bg-destructive" style={{ left: head * pps }} />
          </div>
        </div>
      </div>
    </div>
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
