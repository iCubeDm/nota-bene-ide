// The preview's player (issue 408): one clock, and per track two media elements that follow it, the clip in view and
// the next one preloaded behind it, so a cut swaps to a frame already decoded instead of a black one. Photos are an
// <img> per video track. Every element's sound goes through Web Audio: element → clip gain (its dB × the fades as linear
// ramps) → track gain (dB, mute, solo) → master. The sums are playback.ts's; this file only applies them. The master
// also feeds the level meter (issue 410): an analyser per channel, read by Meter.tsx while playing.
import { cutDuration, isPhotoSrc, type Cut, type CutClip, type CutTrack } from '@nota-bene/shared/cut';
import { peakOf } from './metering.ts';
import { activeClips, audible, clipEnd, clipLevel, fadeRamp, gainAt, lastFrame, layerOpacity, nextClip, sourceTime, syncAction, trackLevel } from './playback.ts';

/** What the controls draw: a new object on each change, so it can be a useSyncExternalStore snapshot. */
export type PlayerState = { t: number; playing: boolean; duration: number; /** an edit to play (none while it has problems) */ ready: boolean; /** counts the seeks */ seeks: number };

type Media = {
  el: HTMLMediaElement;
  /** the clip it is loaded for, and its URL */
  clip: string | null;
  url: string | null;
  /** where the clip starts in what it plays when it was loaded: its in-point, 0 in a reversed copy */
  from: number;
  /** the clip gain node and the ramp scheduled on it (clip id and the clock's epoch) */
  gain?: GainNode;
  ramp: string | null;
};
type Slot = {
  track: CutTrack;
  /** a video track's box in the frame: its two videos and a photo */
  layer?: HTMLDivElement;
  img?: HTMLImageElement;
  /** the next photo, fetched ahead */
  pre?: HTMLImageElement;
  media: [Media, Media];
  gain?: GainNode;
  /** it added neither picture nor sound at the last step */
  silent?: boolean;
  /** it became heard or seen while playing: its clip loads on the run, the clock does not wait for it */
  joining?: boolean;
};

export type PlayerOptions = {
  /** a source's URL */
  url: (src: string) => string;
  /**
   * a reversed clip's copy's URL (issue 492), of its sound alone on an audio track; null while it is being made or when it
   * cannot be: the clip shows and sounds nothing
   */
  reversed?: (c: CutClip, sound: boolean) => string | null;
  /** an element could not load `url`: true for a reversed clip's copy (removed under the page), which is then asked for
   *  again and loaded afresh, even under the same URL */
  failed?: (url: string) => boolean;
  /** ms; performance.now by default */
  now?: () => number;
  frame?: (f: () => void) => number;
  cancel?: (id: number) => void;
};

// gain changes outside the fades (a seek, a track's level, scrubbing) ease in over about this long, not click
const EASE = 0.01;

const fill = { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'contain' } as const;

export class CutPlayer {
  private cut: Cut | null = null;
  private duration = 0;
  private slots: Slot[] = [];
  private box: HTMLElement | null = null;
  private base = 0; // the clock: `base` seconds at `started` ms while playing; `base` while paused
  private started = 0;
  private playing = false;
  private holding = false; // playing, but the clock waits for a clip in view that is still seeking or loading
  private scrubbing = false;
  private live = false; // the tab is shown: until it is, no source is loaded
  private resume = false;
  private epoch = 0; // bumped on play, seek and a new edit: the ramps are scheduled again
  private raf: number | null = null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private meter: { an: [AnalyserNode, AnalyserNode]; buf: Float32Array<ArrayBuffer> } | null = null;
  private snap: PlayerState = { t: 0, playing: false, duration: 0, ready: false, seeks: 0 };
  private seeks = 0;
  private subs = new Set<() => void>();
  private readonly now: () => number;
  private readonly frame: (f: () => void) => number;
  private readonly cancel: (id: number) => void;

  private readonly opts: PlayerOptions;

  constructor(opts: PlayerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => performance.now());
    this.frame = opts.frame ?? ((f) => requestAnimationFrame(f));
    this.cancel = opts.cancel ?? ((id) => cancelAnimationFrame(id));
    // a hidden browser tab runs no animation frames: the elements would play on past their clips, unchecked
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  private onVisibility = () => { if (document.hidden) this.pause(); };

  subscribe = (f: () => void): (() => void) => {
    this.subs.add(f);
    return () => void this.subs.delete(f);
  };
  state = (): PlayerState => this.snap;
  time(): number {
    return this.playing && !this.holding ? Math.min(this.duration, this.base + (this.now() - this.started) / 1000) : this.base;
  }
  get fps(): number { return this.cut?.fps ?? 30; }
  /** the edit it plays; null while the edit has problems */
  get edit(): Cut | null { return this.cut; }

  /** A new or edited edit (null: nothing plays, the clock still moves over `end` seconds). */
  setCut(cut: Cut | null, end = cut ? cutDuration(cut) : 0): void {
    if (!cut) this.pause();
    const same = cut && this.slots.length === cut.tracks.length && cut.tracks.every((t, i) => this.slots[i]!.track.id === t.id && this.slots[i]!.track.kind === t.kind);
    this.cut = cut;
    this.duration = Math.max(0, end);
    if (!same) {
      this.dropSlots();
      for (const t of cut?.tracks ?? []) this.slots.push(this.makeSlot(t));
      this.mount();
    } else {
      cut.tracks.forEach((t, i) => { this.slots[i]!.track = t; });
    }
    // an element keeps its clip while the edit still has it from the same source and in-point (an edit of a fade, a
    // track's gain, another clip): no reload, no seek, no swap mid-play; any other is looked up again
    const keep = new Map(cut?.clips.map((c) => [c.id, c]));
    for (const s of this.slots) for (const m of s.media) {
      const c = m.clip === null ? undefined : keep.get(m.clip);
      if (!c || c.track !== s.track.id || this.mediaUrl(c, s) !== m.url || sourceTime(c, c.at) !== m.from) m.clip = null;
      m.ramp = null;
    }
    this.levels();
    if (this.base > this.duration) this.base = this.duration;
    this.epoch++;
    this.tick();
    this.emit();
  }

  /** The element the video layers go into: the output frame. */
  attach(box: HTMLElement | null): void {
    for (const s of this.slots) s.layer?.remove();
    this.box = box;
    this.mount();
    this.tick();
  }

  /** The tab shown or not: a hidden one pauses, loads nothing and lets the audio device sleep. */
  setLive(on: boolean): void {
    if (on === this.live) return;
    if (!on) {
      this.pause();
      void this.ctx?.suspend().catch(() => {});
    }
    this.live = on;
    this.tick();
  }

  play(): void {
    if (!this.live || this.playing || !this.cut || this.duration <= 0) return;
    if (this.base >= this.last() - 1e-6) this.base = 0;
    this.settled();
    this.audio();
    this.started = this.now();
    this.playing = true;
    this.epoch++;
    this.tick();
    this.loop();
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.base = this.time();
    this.playing = false;
    this.holding = false;
    this.settled();
    if (this.raf !== null) this.cancel(this.raf);
    this.raf = null;
    this.tick();
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number): void {
    this.base = Math.max(0, Math.min(this.last(), t));
    this.seeks++;
    this.settled();
    this.started = this.now();
    this.epoch++;
    this.tick();
    this.emit();
  }

  /** Dragging the playhead: playback holds and the sound is off until the drag ends, then playing resumes. */
  scrub(on: boolean): void {
    if (on === this.scrubbing) return;
    this.scrubbing = on;
    if (on) {
      this.resume = this.playing;
      this.pause();
    }
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0 : 1, this.ctx.currentTime, EASE);
    if (!on && this.resume) this.play();
  }

  dispose(): void {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.raf !== null) this.cancel(this.raf);
    this.raf = null;
    this.playing = false;
    this.dropSlots();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.meter = null;
    this.subs.clear();
  }

  // the playhead's furthest stop: the last frame (at the end itself nothing shows)
  private last(): number {
    return lastFrame(this.duration, this.fps);
  }

  private emit(): void {
    const t = this.time();
    const s = this.snap;
    const ready = this.cut !== null;
    if (s.t === t && s.playing === this.playing && s.duration === this.duration && s.ready === ready && s.seeks === this.seeks) return;
    this.snap = { t, playing: this.playing, duration: this.duration, ready, seeks: this.seeks };
    for (const f of this.subs) f();
  }

  private loop(): void {
    this.raf = this.frame(() => {
      this.raf = null;
      if (!this.playing) return;
      if (this.time() >= this.duration) {
        this.base = this.last();
        this.playing = false;
        this.holding = false;
      }
      this.tick();
      this.emit();
      if (this.playing) this.loop();
    });
  }

  private makeSlot(track: CutTrack): Slot {
    const video = track.kind === 'video';
    const make = (): Media => {
      const el = video ? document.createElement('video') : document.createElement('audio');
      el.preload = 'auto';
      if (el instanceof HTMLVideoElement) {
        el.playsInline = true;
        Object.assign(el.style, fill, { visibility: 'hidden' });
      }
      // a paused element that finished loading shows the frame it was asked for
      // and so does one that finished a seek it was still busy with when asked (a fast scrub, held-down frame steps)
      const settle = () => { if (!this.playing) this.tick(); };
      el.addEventListener('loadeddata', settle);
      el.addEventListener('seeked', settle);
      const m: Media = { el, clip: null, url: null, from: 0, ramp: null };
      el.addEventListener('error', () => {
        if (m.url !== null && this.opts.failed?.(m.url)) {
          m.url = null; // the next load sets its src again
          m.clip = null;
        }
      });
      return m;
    };
    const slot: Slot = { track, media: [make(), make()] };
    if (video) {
      const layer = document.createElement('div');
      layer.dataset.cutLayer = track.id;
      Object.assign(layer.style, { position: 'absolute', overflow: 'hidden', display: 'none' });
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      Object.assign(img.style, fill, { display: 'none' });
      layer.append(slot.media[0].el, slot.media[1].el, img);
      Object.assign(slot, { layer, img });
    }
    if (this.ctx) this.wire(slot);
    return slot;
  }

  private dropSlots(): void {
    for (const s of this.slots) {
      for (const m of s.media) {
        this.release(m);
        m.gain?.disconnect();
      }
      s.gain?.disconnect();
      s.layer?.remove();
    }
    this.slots = [];
  }

  // an element that plays nothing and lets go of its file (and its connection to the server)
  private release(m: Media): void {
    if (!m.el.paused) m.el.pause();
    if (m.url !== null) {
      m.el.removeAttribute('src'); // and load(): the element lets go of the file
      m.el.load();
    }
    m.url = null;
    m.clip = null;
    m.ramp = null;
  }

  // a play, pause or seek: from here the clock may wait for every track in view again
  private settled(): void {
    for (const s of this.slots) s.joining = false;
  }

  // the layers in tracks order: a later one is drawn over an earlier one
  private mount(): void {
    if (!this.box) return;
    for (const s of this.slots) if (s.layer) this.box.append(s.layer);
  }

  // the Web Audio graph, made on the first play (a user gesture: a context made earlier starts suspended)
  private audio(): void {
    if (!this.ctx && typeof AudioContext !== 'undefined') {
      try {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        this.tapMeter(this.ctx, this.master);
        for (const s of this.slots) this.wire(s);
        this.levels();
      } catch {
        this.meter = null;
        this.ctx = null; // no Web Audio: the elements' own volume carries the gain (tick)
        this.master = null;
      }
    }
    void this.ctx?.resume().catch(() => {});
  }

  // the meter's analysers after the master (so the scrub's silence and every gain show), a mono mix up-mixed to both
  // sides; a browser without them still plays, with no meter
  private tapMeter(ctx: AudioContext, master: GainNode): void {
    try {
      const tap = ctx.createGain();
      tap.channelCount = 2;
      tap.channelCountMode = 'explicit';
      tap.channelInterpretation = 'speakers';
      master.connect(tap);
      const split = ctx.createChannelSplitter(2);
      tap.connect(split);
      const an = [0, 1].map((i) => {
        const a = ctx.createAnalyser();
        // the most samples an analyser keeps: 0.34 s at 48 kHz, 0.17 s at 96 kHz, longer than a frame even at 30 Hz,
        // so no burst between two reads is missed
        a.fftSize = 16384;
        split.connect(a, i);
        return a;
      }) as [AnalyserNode, AnalyserNode];
      this.meter = { an, buf: new Float32Array(16384) };
    } catch {
      this.meter = null;
    }
  }

  /**
   * The mix's sample peak on each side since about the last frame (1 is full scale, more is clipping); null before the
   * first play (no audio graph yet: the meter makes none of its own), without Web Audio, and while the context is not
   * running (suspended in a hidden tab: its analysers hold their last samples).
   */
  meterPeaks(): [number, number] | null {
    const m = this.meter;
    if (!m || this.ctx?.state !== 'running') return null;
    return m.an.map((a) => {
      a.getFloatTimeDomainData(m.buf);
      return peakOf(m.buf);
    }) as [number, number];
  }

  private wire(s: Slot): void {
    const ctx = this.ctx!;
    s.gain = ctx.createGain();
    s.gain.connect(this.master!);
    for (const m of s.media) {
      m.gain = ctx.createGain();
      m.gain.connect(s.gain);
      ctx.createMediaElementSource(m.el).connect(m.gain);
      // the gain nodes carry the level from here on: a level the element got without them (follow, before the first
      // play: 0 at a fade-in's start) would stay on top of them, and keep it silent (issue 429)
      m.el.volume = 1;
      m.ramp = null;
    }
  }

  private levels(): void {
    const cut = this.cut;
    if (cut && this.ctx) for (const s of this.slots) s.gain?.gain.setTargetAtTime(trackLevel(cut, s.track), this.ctx.currentTime, EASE);
  }

  /**
   * Puts every element where the clock is: the clip in view on each track playing (or showing its frame), the next
   * preloaded. While a clip in view is still seeking or has no frame yet, the clock holds (as editors do) instead of
   * running away from it.
   */
  tick(): void {
    const cut = this.cut;
    if (!cut || !this.live) return;
    const t = this.time();
    const on = activeClips(cut, t);
    const plan = this.slots.map((s) => {
      const clip = on.get(s.track.id);
      const next = nextClip(cut, s.track.id, t);
      // a track that adds neither picture nor sound (hidden and muted, or silenced by another's solo) loads nothing.
      // While playing, one that turns silent keeps its elements and goes quiet through its gain (a release would cut
      // the sound mid-ease), and lets go at the next pause; one heard again loads its clip on the run (issue 429)
      const silent = !(s.track.kind === 'video' && !s.track.hidden) && !audible(cut, s.track);
      if (this.playing && s.silent && !silent) s.joining = true;
      s.silent = silent;
      if (silent && !(this.playing && s.media.some((m) => m.url !== null))) {
        for (const m of s.media) this.release(m);
        return { s, clip, next: undefined, photo: undefined, media: undefined, cur: undefined };
      }
      const photo = clip && isPhotoSrc(clip.src) ? clip : undefined;
      // a reversed clip whose copy is not there yet plays as a gap
      const media = clip && !photo && this.mediaUrl(clip, s) !== null ? clip : undefined;
      const nextMedia = next && !isPhotoSrc(next.src) && this.mediaUrl(next, s) !== null ? next : undefined;
      const cur = media ? s.media.find((m) => m.clip === media.id) ?? s.media.find((m) => m.clip !== nextMedia?.id) ?? s.media[0] : undefined;
      // the one already holding the next clip, else the other: never both loading one file
      const spare = s.media.find((m) => m !== cur && m.clip === nextMedia?.id) ?? s.media.find((m) => m !== cur)!;
      if (nextMedia) this.load(spare, nextMedia, nextMedia.at, this.mediaUrl(nextMedia, s)!);
      if (cur && media) this.load(cur, media, t, this.mediaUrl(media, s)!);
      return { s, clip, next, photo, media, cur };
    });
    if (this.playing && !this.scrubbing) {
      // a track joining mid-play or a silent one does not stop the others
      const waiting = plan.some(({ s, cur, media }) => cur && media && !s.joining && !s.silent && this.unready(cur.el, media, t));
      if (waiting && !this.holding) {
        this.base = this.time();
        this.holding = true;
      } else if (!waiting && this.holding) {
        this.started = this.now();
        this.holding = false;
        this.epoch++; // the sound waited too: its ramps start again from here
      }
    }
    const run = this.playing && !this.scrubbing && !this.holding;
    for (const { s, clip, next, photo, media, cur } of plan) {
      for (const m of s.media) {
        if (m === cur) continue;
        if (!m.el.paused) m.el.pause();
        if (m.el instanceof HTMLVideoElement) m.el.style.visibility = 'hidden';
      }
      if (cur && media) {
        this.follow(cur, media, t, run);
        if (cur.el instanceof HTMLVideoElement) cur.el.style.visibility = 'visible';
      }
      if (next && isPhotoSrc(next.src) && !s.track.hidden) {
        const url = this.opts.url(next.src);
        if ((s.pre ??= new Image()).getAttribute('src') !== url) s.pre.src = url;
      }
      this.draw(s, clip, photo, t);
    }
  }

  // seeking, or no frame at the playhead yet; a file that failed or a source that ended is not waited for
  private unready(el: HTMLMediaElement, clip: CutClip, t: number): boolean {
    if (el.error || el.ended || this.past(el, clip, t)) return false;
    return el.seeking || el.readyState < 2;
  }

  // the clock wants a time at or after the end of the file (an `out` past it): the last frame holds
  private past(el: HTMLMediaElement, clip: CutClip, t: number): boolean {
    return Number.isFinite(el.duration) && sourceTime(clip, t) >= el.duration - 0.5 / this.fps;
  }

  // what a video or audio clip plays: its source, or a reversed clip's copy (null until it is made)
  private mediaUrl(c: CutClip, s: Slot): string | null {
    return c.reverse ? this.opts.reversed?.(c, s.track.kind === 'audio') ?? null : this.opts.url(c.src);
  }

  private load(m: Media, clip: CutClip, t: number, url: string): void {
    if (m.clip === clip.id) return;
    if (m.url !== url) {
      m.el.src = url;
      m.url = url;
    }
    m.clip = clip.id;
    m.from = sourceTime(clip, clip.at);
    m.ramp = null;
    // already there (the same file at the same place): a seek would only cost a decode
    const want = sourceTime(clip, t);
    if (Math.abs(m.el.currentTime - want) > 1 / this.fps) m.el.currentTime = want;
  }

  // drift against the clock, the sound's level, and play or pause
  private follow(m: Media, clip: CutClip, t: number, run: boolean): void {
    const el = m.el;
    // past the file's end: no play() (it would start over from 0), the last frame stays
    const over = el.ended || this.past(el, clip, t);
    const want = Number.isFinite(el.duration) ? Math.min(sourceTime(clip, t), el.duration) : sourceTime(clip, t);
    const go = run && !over;
    if (go && el.paused) void el.play()?.catch(() => {});
    if (!go && !el.paused) el.pause();
    // a starting or seeking element has no time worth comparing yet: seeking again would only restart it
    if (!el.seeking && !el.ended && (!go || el.readyState >= 3)) {
      const a = syncAction(el.currentTime, want, this.fps, go);
      if (a.seek !== undefined) el.currentTime = a.seek;
      if (el.playbackRate !== a.rate) el.playbackRate = a.rate;
    }
    const cut = this.cut!;
    if (m.gain && this.ctx) {
      const key = `${clip.id}@${this.epoch}`;
      if (run && m.ramp !== key) {
        const g = m.gain.gain;
        const at = this.ctx.currentTime;
        const level = clipLevel(clip);
        const [first, ...rest] = fadeRamp(clip, t);
        // from the level it has to the fade's in EASE, the fades' corners, then silence from the clip's end on (an
        // element that runs on past `out` until the next frame is not heard)
        g.cancelScheduledValues(at);
        g.setValueAtTime(g.value, at);
        g.linearRampToValueAtTime(first!.v * level, at + EASE);
        for (const p of rest) g.linearRampToValueAtTime(p.v * level, at + Math.max(EASE, p.t - t));
        g.setValueAtTime(0, at + Math.max(EASE, clipEnd(clip) - t));
        m.ramp = key;
      }
    } else {
      el.volume = Math.min(1, gainAt(cut, clip, t));
    }
  }

  // a video track's box at the clip's place (fractions of the frame) at its opacity and fades, its photo shown in it or not
  private draw(s: Slot, clip: CutClip | undefined, photo: CutClip | undefined, t: number): void {
    const { layer, img } = s;
    if (!layer || !img) return;
    const shown = !!clip && !s.track.hidden;
    layer.style.display = shown ? '' : 'none';
    if (shown) {
      const p = clip.place ?? { x: 0, y: 0, w: 1, h: 1 };
      Object.assign(layer.style, { left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%`, opacity: String(layerOpacity(clip, t)) });
    }
    if (photo && shown) {
      const url = this.opts.url(photo.src);
      if (img.getAttribute('src') !== url) img.src = url;
    }
    img.style.display = photo ? '' : 'none';
  }
}
