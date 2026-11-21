import { useEffect, useState } from 'react';
import { isPhotoSrc, type Cut, type CutClip, type CutPlace } from '@nota-bene/shared/cut';
import { basename } from '@nota-bene/shared/paths';
import { useT } from '@/sdk';
import { FULL, ms, setClip, setClips } from './ops.ts';

type Patch = Parameters<typeof setClip>[2];

/**
 * The selected clip's numbers (issue 409): where it starts, the used part of its source (a photo: how long it shows),
 * its sound's gain and mute, whether it plays backwards (issue 492), its fades (on a video track the picture's too, issue 431), and on a video track its frame (percent of the output frame) and opacity, with "Fit to
 * frame" to drop the frame. A value the format refuses is marked and not applied.
 */
export function Inspector({ cut, clip: c, commit }: { cut: Cut; clip: CutClip; commit: (c: Cut) => void }) {
  const t = useT();
  const video = cut.tracks.find((x) => x.id === c.track)?.kind === 'video';
  const photo = isPhotoSrc(c.src);
  const p = c.place ?? FULL;
  const apply = (patch: Patch): boolean => {
    const next = setClip(cut, c.id, patch);
    if (next) commit(next);
    return next !== null;
  };
  const place = (k: keyof CutPlace, v: number) => apply({ place: { ...p, [k]: v } });
  const sec = (v: number | undefined) => v ?? 0;
  const pct = (v: number) => Math.round(v * 1000) / 10;
  return (
    <aside data-cut-inspector aria-label={t('cutInspector')} className="flex w-52 flex-none flex-col gap-1 overflow-auto border-l border-border-soft bg-chrome p-2 text-xs">
      <p className="truncate font-medium text-foreground" title={c.src}>{basename(c.src)}</p>
      <Num label={t('cutAt')} value={c.at} onSet={(v) => apply({ at: ms(v) })} />
      {photo ? (
        <Num label={t('cutDur')} value={sec(c.dur)} onSet={(v) => apply({ dur: ms(v) })} />
      ) : (
        <>
          <Num label={t('cutIn')} value={sec(c.in)} onSet={(v) => apply({ in: ms(v) || undefined })} />
          <Num label={t('cutOut')} value={sec(c.out)} onSet={(v) => apply({ out: ms(v) })} />
          <Num label={t('cutGain')} value={c.gain ?? 0} step={0.5} onSet={(v) => apply({ gain: v || undefined })} />
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input type="checkbox" checked={!!c.mute} onChange={(e) => apply({ mute: e.target.checked || undefined })} />
            {t('cutClipMute')}
          </label>
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input type="checkbox" checked={!!c.reverse} onChange={(e) => apply({ reverse: e.target.checked || undefined })} />
            {t('cutReverse')}
          </label>
        </>
      )}
      {/* a photo's fades fade its picture (issue 431) */}
      <Num label={t('cutFadeIn')} value={sec(c.fadeIn)} onSet={(v) => apply({ fadeIn: ms(v) || undefined })} />
      <Num label={t('cutFadeOut')} value={sec(c.fadeOut)} onSet={(v) => apply({ fadeOut: ms(v) || undefined })} />
      {video && (
        <>
          <Num label={t('cutPlaceX')} value={pct(p.x)} onSet={(v) => place('x', v / 100)} />
          <Num label={t('cutPlaceY')} value={pct(p.y)} onSet={(v) => place('y', v / 100)} />
          <Num label={t('cutPlaceW')} value={pct(p.w)} onSet={(v) => place('w', v / 100)} />
          <Num label={t('cutPlaceH')} value={pct(p.h)} onSet={(v) => place('h', v / 100)} />
          <Num label={t('cutOpacity')} value={pct(p.opacity ?? 1)} onSet={(v) => place('opacity', v / 100)} />
          <button type="button" disabled={!c.place} onClick={() => apply({ place: undefined })} className="mt-1 rounded border border-border-soft px-2 py-0.5 text-foreground hover:bg-muted disabled:opacity-50">
            {t('cutFit')}
          </button>
        </>
      )}
    </aside>
  );
}

/**
 * Several selected clips (issue 432): how many, and the fields they share, each set on all of them at once: the sound's
 * gain, mute and reverse (on the clips with sound) and the fades; issue 442: on the video tracks' clips their frame and opacity, each
 * clip keeping the rest of its own frame. A field whose values differ shows empty, "mixed"; a value the format refuses for any
 * of them is marked and applied to none.
 */
export function GroupInspector({ cut, clips, commit }: { cut: Cut; clips: CutClip[]; commit: (c: Cut) => void }) {
  const t = useT();
  const sound = clips.filter((c) => !isPhotoSrc(c.src));
  const apply = (on: CutClip[], patch: Patch): boolean => {
    const next = setClips(cut, on.map((c) => c.id), patch);
    if (next) commit(next);
    return next !== null;
  };
  const same = (on: CutClip[], f: (c: CutClip) => number | boolean) => {
    const v = on.map(f);
    return v.every((x) => x === v[0]) ? v[0]! : null;
  };
  const muted = same(sound, (c) => !!c.mute);
  const backwards = same(sound, (c) => !!c.reverse);
  // the frame's field `k` set on every selected clip of a video track, as one step
  const video = clips.filter((c) => cut.tracks.find((x) => x.id === c.track)?.kind === 'video');
  const placeAll = (k: keyof CutPlace, v: number): boolean => {
    let next: Cut | null = cut;
    for (const c of video) next = next && setClip(next, c.id, { place: { ...(c.place ?? FULL), [k]: v } });
    if (next) commit(next);
    return next !== null;
  };
  // compared as shown, in percent to a tenth: 0.333 and 0.33299999999999996 are the same 33.3
  const placed = (k: keyof CutPlace, d = 0) => same(video, (c) => Math.round(((c.place ?? FULL)[k] ?? d) * 1000) / 10) as number | null;
  return (
    <aside data-cut-inspector aria-label={t('cutInspector')} className="flex w-52 flex-none flex-col gap-1 overflow-auto border-l border-border-soft bg-chrome p-2 text-xs">
      <p className="font-medium text-foreground">{t('cutClipsN', clips.length)}</p>
      {sound.length > 0 && (
        <>
          <Num label={t('cutGain')} value={same(sound, (c) => c.gain ?? 0) as number | null} step={0.5} onSet={(v) => apply(sound, { gain: v || undefined })} />
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input
              type="checkbox" checked={muted === true} ref={(el) => { if (el) el.indeterminate = muted === null; }}
              onChange={() => apply(sound, { mute: muted === true ? undefined : true })}
            />
            {t('cutClipMute')}
          </label>
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input
              type="checkbox" checked={backwards === true} ref={(el) => { if (el) el.indeterminate = backwards === null; }}
              onChange={() => apply(sound, { reverse: backwards === true ? undefined : true })}
            />
            {t('cutReverse')}
          </label>
        </>
      )}
      <Num label={t('cutFadeIn')} value={same(clips, (c) => c.fadeIn ?? 0) as number | null} onSet={(v) => apply(clips, { fadeIn: ms(v) || undefined })} />
      <Num label={t('cutFadeOut')} value={same(clips, (c) => c.fadeOut ?? 0) as number | null} onSet={(v) => apply(clips, { fadeOut: ms(v) || undefined })} />
      {video.length > 0 && (
        <>
          <Num label={t('cutPlaceX')} value={placed('x')} onSet={(v) => placeAll('x', v / 100)} />
          <Num label={t('cutPlaceY')} value={placed('y')} onSet={(v) => placeAll('y', v / 100)} />
          <Num label={t('cutPlaceW')} value={placed('w')} onSet={(v) => placeAll('w', v / 100)} />
          <Num label={t('cutPlaceH')} value={placed('h')} onSet={(v) => placeAll('h', v / 100)} />
          <Num label={t('cutOpacity')} value={placed('opacity', 1)} onSet={(v) => placeAll('opacity', v / 100)} />
        </>
      )}
    </aside>
  );
}

/**
 * A number applied on Enter or leaving the field; one the edit refuses stays shown, marked, until changed. null: the
 * selected clips differ (issue 432), the field empty, "mixed", until a value is typed.
 */
function Num({ label, value, onSet, step = 0.1 }: { label: string; value: number | null; onSet: (v: number) => boolean; step?: number }) {
  const t = useT();
  const [text, setText] = useState(value === null ? '' : String(value));
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(value === null ? '' : String(value)); setBad(false); }, [value]);
  const done = () => {
    const v = Number(text);
    if (value === null && text.trim() === '') return setBad(false);
    if (text.trim() === '' || !Number.isFinite(v)) return setBad(true);
    if (v === value) return setBad(false);
    setBad(!onSet(v));
  };
  return (
    <label className="flex items-center justify-between gap-2 text-muted-foreground">
      <span className="truncate">{label}</span>
      <input
        type="number" step={step} aria-label={label} value={text} placeholder={value === null ? t('cutMixed') : undefined} aria-invalid={bad || undefined} title={bad ? t('cutInvalid') : undefined}
        onChange={(e) => setText(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === 'Enter') done(); }}
        className={`h-5 w-20 rounded border bg-background px-1 text-right font-mono text-foreground outline-0 ${bad ? 'border-destructive' : 'border-border-soft'}`}
      />
    </label>
  );
}
