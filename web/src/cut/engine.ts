// The preview's player (issue 408): one clock, and per track two media elements that follow it, the clip in view and
// the next one preloaded behind it, so a cut swaps to a frame already decoded instead of a black one. Photos are an
// <img> per video track. Every element's sound goes through Web Audio: element → clip gain (its dB × the fades as linear
// ramps) → track gain (dB, mute, solo) → master. The sums are playback.ts's; this file only applies them.
import { cutDuration, isPhotoSrc, type Cut, type CutClip, type CutTrack } from '@nota-bene/shared/cut';
import { activeClips, clipLevel, fadeRamp, gainAt, nextClip, sourceTime, syncAction, trackLevel } from './playback.ts';

/** What the controls draw: a new object on each change, so it can be a useSyncExternalStore snapshot. */
export type PlayerState = { t: number; playing: boolean; duration: number; /** an edit to play (none while it has problems) */ ready: boolean };

type Media = {
  el: HTMLMediaElement;
  /** the clip it is loaded for, and its URL */
  clip: string | null;
  url: string | null;
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
};

export type PlayerOptions = {
  /** a source's URL */
  url: (src: string) => string;
  /** ms; performance.now by default */
  now?: () => number;
  frame?: (f: () => void) => number;
  cancel?: (id: number) => void;
};

const fill = { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'contain' } as const;

export class CutPlayer {
  private cut: Cut | null = null;
  private duration = 0;
  private slots: Slot[] = [];
  private box: HTMLElement | null = null;
  private base = 0; // the clock: `base` seconds at `started` ms while playing; `base` while paused
  private started = 0;
  private playing = false;
  private scrubbing = false;
  private live = false; // the tab is shown: until it is, no source is loaded
  private resume = false;
  private epoch = 0; // bumped on play, seek and a new edit: the ramps are scheduled again
  private raf: number | null = null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private snap: PlayerState = { t: 0, playing: false, duration: 0, ready: false };
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
  }

  subscribe = (f: () => void): (() => void) => {
    this.subs.add(f);
    return () => void this.subs.delete(f);
  };
  state = (): PlayerState => this.snap;
  time(): number {
    return this.playing ? Math.min(this.duration, this.base + (this.now() - this.started) / 1000) : this.base;
  }
  get fps(): number { return this.cut?.fps ?? 30; }
  /** the edit it plays; null while the edit has problems */
  get edit(): Cut | null { return this.cut; }

  /** A new or edited edit (null: nothing plays, the clock still moves over `end` seconds). */
  setCut(cut: Cut | null, end = cut ? cutDuration(cut) : 0): void {
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
    for (const s of this.slots) for (const m of s.media) m.clip = null; // looked up again; the same URL does not reload
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

  /** The tab shown or not: a hidden one pauses and loads nothing. */
  setLive(on: boolean): void {
    if (on === this.live) return;
    if (!on) this.pause();
    this.live = on;
    this.tick();
  }

  play(): void {
    if (!this.live || this.playing || !this.cut || this.duration <= 0) return;
    if (this.base >= this.duration - 1e-6) this.base = 0;
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
    this.base = Math.max(0, Math.min(this.duration, t));
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
    if (this.master) this.master.gain.value = on ? 0 : 1;
    if (!on && this.resume) this.play();
  }

  dispose(): void {
    if (this.raf !== null) this.cancel(this.raf);
    this.raf = null;
    this.playing = false;
    this.dropSlots();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.subs.clear();
  }

  private emit(): void {
    const t = this.time();
    const s = this.snap;
    const ready = this.cut !== null;
    if (s.t === t && s.playing === this.playing && s.duration === this.duration && s.ready === ready) return;
    this.snap = { t, playing: this.playing, duration: this.duration, ready };
    for (const f of this.subs) f();
  }

  private loop(): void {
    this.raf = this.frame(() => {
      this.raf = null;
      if (!this.playing) return;
      if (this.time() >= this.duration) {
        this.base = this.duration;
        this.playing = false;
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
      el.addEventListener('loadeddata', () => { if (!this.playing) this.tick(); });
      return { el, clip: null, url: null, ramp: null };
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
        if (!m.el.paused) m.el.pause();
        if (m.url !== null) {
          m.el.removeAttribute('src'); // and load(): the element lets go of the file
          m.el.load();
        }
        m.gain?.disconnect();
      }
      s.gain?.disconnect();
      s.layer?.remove();
    }
    this.slots = [];
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
        for (const s of this.slots) this.wire(s);
        this.levels();
      } catch {
        this.ctx = null; // no Web Audio: the elements' own volume carries the gain (tick)
        this.master = null;
      }
    }
    void this.ctx?.resume().catch(() => {});
  }

  private wire(s: Slot): void {
    const ctx = this.ctx!;
    s.gain = ctx.createGain();
    s.gain.connect(this.master!);
    for (const m of s.media) {
      m.gain = ctx.createGain();
      m.gain.connect(s.gain);
      ctx.createMediaElementSource(m.el).connect(m.gain);
      m.ramp = null;
    }
  }

  private levels(): void {
    const cut = this.cut;
    if (cut) for (const s of this.slots) if (s.gain) s.gain.gain.value = trackLevel(cut, s.track);
  }

  /** Puts every element where the clock is: the clip in view on each track playing (or showing its frame), the next preloaded. */
  tick(): void {
    const cut = this.cut;
    if (!cut || !this.live) return;
    const t = this.time();
    const on = activeClips(cut, t);
    const run = this.playing && !this.scrubbing;
    for (const s of this.slots) {
      const clip = on.get(s.track.id);
      const next = nextClip(cut, s.track.id, t);
      const photo = clip && isPhotoSrc(clip.src) ? clip : undefined;
      const media = clip && !photo ? clip : undefined;
      const nextMedia = next && !isPhotoSrc(next.src) ? next : undefined;
      const cur = media ? s.media.find((m) => m.clip === media.id) ?? s.media.find((m) => m.clip !== nextMedia?.id) ?? s.media[0] : undefined;
      const spare = s.media.find((m) => m !== cur && (!cur || m.clip === nextMedia?.id)) ?? s.media.find((m) => m !== cur)!;
      if (nextMedia) this.load(spare, nextMedia, nextMedia.at);
      for (const m of s.media) {
        if (m === cur) continue;
        if (!m.el.paused) m.el.pause();
        if (m.el instanceof HTMLVideoElement) m.el.style.visibility = 'hidden';
      }
      if (cur && media) {
        this.load(cur, media, t);
        this.follow(cur, media, t, run);
        if (cur.el instanceof HTMLVideoElement) cur.el.style.visibility = 'visible';
      }
      if (next && isPhotoSrc(next.src)) (s.pre ??= new Image()).src = this.opts.url(next.src);
      this.draw(s, clip, photo);
    }
  }

  private load(m: Media, clip: CutClip, t: number): void {
    if (m.clip === clip.id) return;
    const url = this.opts.url(clip.src);
    if (m.url !== url) {
      m.el.src = url;
      m.url = url;
    }
    m.clip = clip.id;
    m.ramp = null;
    m.el.currentTime = sourceTime(clip, t);
  }

  // drift against the clock, the sound's level, and play or pause
  private follow(m: Media, clip: CutClip, t: number, run: boolean): void {
    const el = m.el;
    const want = sourceTime(clip, t);
    if (run && el.paused) void el.play()?.catch(() => {});
    if (!run && !el.paused) el.pause();
    // a starting or seeking element has no time worth comparing yet: seeking again would only restart it
    if (!el.seeking && (!run || el.readyState >= 3)) {
      const a = syncAction(el.currentTime, want, this.fps, run);
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
        g.cancelScheduledValues(at);
        g.setValueAtTime(first!.v * level, at);
        for (const p of rest) g.linearRampToValueAtTime(p.v * level, at + p.t - t);
        m.ramp = key;
      }
    } else {
      el.volume = Math.min(1, gainAt(cut, clip, t));
    }
  }

  // a video track's box at the clip's place (fractions of the frame), its photo shown in it or not
  private draw(s: Slot, clip: CutClip | undefined, photo: CutClip | undefined): void {
    const { layer, img } = s;
    if (!layer || !img) return;
    const shown = !!clip && !s.track.hidden;
    layer.style.display = shown ? '' : 'none';
    if (shown) {
      const p = clip.place ?? { x: 0, y: 0, w: 1, h: 1 };
      Object.assign(layer.style, { left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%`, opacity: String(p.opacity ?? 1) });
    }
    if (photo) {
      const url = this.opts.url(photo.src);
      if (img.getAttribute('src') !== url) img.src = url;
    }
    img.style.display = photo ? '' : 'none';
  }
}
