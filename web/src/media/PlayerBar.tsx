import { has } from '@nota-bene/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { selectMediaComments } from '@/comments/slice.ts';
import { selectFileVersion } from '@/files/slice.ts';
import { useT, useAppDispatch, useAppSelector, useMedia } from '@/sdk';
import { changedSince } from './markup/MediaMarks.tsx';
import { BarButton, ChoiceMenu, SPEEDS, VolumeControl } from './PlayerControls.tsx';
import { applyPlayerKey, startAnnotate, type Flash } from './playerKeys.ts';
import { EnterFullscreenIcon, ExitFullscreenIcon, PauseIcon, PencilIcon, PipIcon, PlayIcon, ReplayIcon } from './playerIcons.tsx';
import { SEEK_STEPS, seekStep, useSeekStep, type SeekStepValue } from './seekStep.ts';
import { Timeline } from './Timeline.tsx';
import { BAR_MIN_PX, useBarRect } from './useBarRect.ts';
import { formatTime, type MarkerIn } from './timelineMath.ts';
import { useMediaState } from './useMediaState.ts';

/** While playing, the bar and the cursor go away after this long without the pointer moving over the player. */
export const HIDE_AFTER_MS = 2500;

/**
 * Whether the video's bar shows: always while paused, hovered, a menu is open or the timeline is being scrubbed; while
 * playing, until HIDE_AFTER_MS pass without pointer movement over `box`. `wake` shows it for that long (a key).
 * The cursor over the player follows it.
 */
function useBarVisible(box: MutableRefObject<HTMLElement | null>, paused: boolean, hold: boolean, flash: Flash | null) {
  const [awake, setAwake] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wake = useCallback(() => {
    setAwake(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAwake(false), HIDE_AFTER_MS);
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const leave = () => { clearTimeout(timer.current); setAwake(false); };
    el.addEventListener('pointermove', wake);
    el.addEventListener('pointerdown', wake);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', wake);
      el.removeEventListener('pointerdown', wake);
      el.removeEventListener('pointerleave', leave);
      clearTimeout(timer.current);
    };
  }, [box, wake]);
  useEffect(() => { if (flash) wake(); }, [flash, wake]);
  useEffect(() => { wake(); }, [paused, wake]);
  const show = awake || paused || hold;
  useEffect(() => {
    const el = box.current;
    if (el) el.style.cursor = show ? '' : 'none';
    return () => { if (el) el.style.cursor = ''; };
  }, [box, show]);
  return show;
}

/**
 * An audio bar is a size container (issue 453): in a narrow place (a table cell, a thin column) it sheds controls instead
 * of wrapping them, first the seek-step chip, then speed (the volume slider shrinks into the room left, and goes below
 * 15rem; VolumeControl), down to its min width: play, mute and the time. The widths are the content box each needs,
 * measured in Chromium with the widest chips ("±0.5 s", "0.25×") and the widest time of the media's length
 * ("9:59.999", "59:59.999", "10:00:00.000"), gaps included. A video bar is no container: it has its own BAR_MIN_PX rule.
 */
const FITS = {
  // under 10 min: the row is 324 px with both chips, 264 px with speed alone
  short: { min: 'min-w-64', step: '@max-[20.5rem]:hidden', speed: '@max-[16.75rem]:hidden' },
  // under an hour: 341 / 281 px
  mid: { min: 'min-w-64', step: '@max-[21.5rem]:hidden', speed: '@max-[18rem]:hidden' },
  // an hour or more: 382 / 322 px; play, mute and the time alone need 264 px
  long: { min: 'min-w-[18.5rem]', step: '@max-[24rem]:hidden', speed: '@max-[20.5rem]:hidden' },
} as const;
const fitsFor = (duration: number) => FITS[duration >= 3600 ? 'long' : duration >= 600 ? 'mid' : 'short'];

/** `document.fullscreenElement` is the player container. */
function useIsFullscreen(box: MutableRefObject<HTMLElement | null>): boolean {
  const [fs, setFs] = useState(false);
  useEffect(() => {
    const sync = () => setFs(!!box.current && document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [box]);
  return fs;
}

/**
 * The player's own control bar, replacing the native one: the timeline with the comments' ticks, play, volume, time,
 * speed, and for a video ✎ (annotate), picture-in-picture and fullscreen of the container `box` (video, marks and bar
 * together). A video's bar overlays the container's bottom with a gradient; an audio's sits in the layout, always shown.
 */
export function PlayerBar({ media, box, tabId, path = '', refName, flash, onTick }: {
  media: HTMLMediaElement; box: MutableRefObject<HTMLElement | null>; flash: Flash | null; path?: string; refName?: string;
  /** Without `tabId` (a chat reply) there is no ✎. */
  tabId?: string;
  /** A tick's click goes here instead of seeking this element (the chat opens the file's tab at that time). */
  onTick?: (time: number) => void;
}) {
  const t = useT();
  const dispatch = useAppDispatch();
  const ctl = useMedia();
  const video = media instanceof HTMLVideoElement;
  const state = useMediaState(media);
  const offered = useAppSelector((s) => has(s.controls.protocol, 'mediaAnchors'));
  const comments = useAppSelector((s) => selectMediaComments(s, path, refName));
  const version = useAppSelector((s) => selectFileVersion(s, path, refName));
  const items = useMemo<MarkerIn[]>(() => !video ? [] : comments.flatMap((c) =>
    c.anchor.time === undefined ? [] : [{ id: c.id, time: c.anchor.time, text: c.text, dim: c.status === 'sent' || changedSince(c, version) }],
  ), [video, comments, version]);

  const [menu, setMenu] = useState(false);
  const [scrub, setScrub] = useState(false);
  const [hover, setHover] = useState(false);
  const fs = useIsFullscreen(box);
  const place = useBarRect(media as HTMLVideoElement, box, video);
  const visible = useBarVisible(box, state.paused, menu || scrub || hover, flash);
  const show = !video || visible;
  const unit = t('unitSec');
  const step = useSeekStep();
  const key = (code: string) => void applyPlayerKey(media, code, unit, box.current);

  const label = state.ended ? 'pb_replay' : state.paused ? 'pb_play' : 'pb_pause';
  const Play = state.ended ? ReplayIcon : state.paused ? PlayIcon : PauseIcon;
  // a bar narrower than BAR_MIN_PX (a small video in the chat column) drops speed and PiP so the row never wraps
  const compact = video && !!place && place.width < BAR_MIN_PX;
  const fits = fitsFor(state.duration);
  const pip = video && !compact && typeof document !== 'undefined' && !!document.pictureInPictureEnabled;
  return (
    <div
      data-player-bar
      data-anchor-skip
      inert={!show}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={video && place ? { left: place.left, width: place.width, bottom: place.bottom } : undefined}
      className={video
        ? `pointer-events-none absolute ${place ? '' : 'inset-x-0 bottom-0 '}z-20 bg-gradient-to-t from-scrim/75 to-transparent px-3 pt-10 pb-1.5 text-on-scrim transition-opacity duration-200 ${show ? 'opacity-100' : 'opacity-0'}`
        : `@container w-full max-w-[min(36rem,calc(100%-2rem))] ${fits.min} rounded-lg border border-border bg-card px-3 pt-1.5 pb-1 text-foreground`}
    >
      <div className={video ? 'pointer-events-auto' : ''}>
        <Timeline media={media} state={state} items={items} onScrub={setScrub} onTick={onTick} />
        <div className="flex items-center gap-1">
          <BarButton label={t(label)} onClick={() => key('KeyK')}><Play /></BarButton>
          <VolumeControl media={media} state={state} onMute={() => key('KeyM')} />
          <span className="ml-1 text-[0.8125rem] whitespace-nowrap tabular-nums opacity-90">{formatTime(state.time)} / {formatTime(state.duration)}</span>
          <span className="flex-1" />
          {!compact && <ChoiceMenu className={video ? '' : fits.step} label={t('pb_seekStep')} options={SEEK_STEPS} value={step} text={(v) => `±${v} ${unit}`} item={(v) => `${v} ${unit}`} onPick={(v) => seekStep.set(v as SeekStepValue)} onOpen={setMenu} />}
          {!compact && <ChoiceMenu className={video ? '' : fits.speed} label={t('pb_speed')} options={SPEEDS} value={state.rate} text={(r) => `${r}×`} onPick={(r) => void (media.playbackRate = r)} onOpen={setMenu} />}
          {video && offered && tabId && <BarButton label={t('pb_annotate')} onClick={() => startAnnotate(dispatch, tabId, media)}><PencilIcon /></BarButton>}
          {pip && <BarButton label={t('pb_pip')} onClick={() => void ctl.togglePip(media)}><PipIcon /></BarButton>}
          {video && <BarButton label={t(fs ? 'pb_exitFullscreen' : 'pb_fullscreen')} onClick={() => key('KeyF')}>{fs ? <ExitFullscreenIcon /> : <EnterFullscreenIcon />}</BarButton>}
        </div>
      </div>
    </div>
  );
}
