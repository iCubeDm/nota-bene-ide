import { useEffect, useState } from 'react';
import { isPhotoSrc, type Cut, type CutClip, type CutPlace } from '@nota-bene/shared/cut';
import { basename } from '@nota-bene/shared/paths';
import { useT } from '@/i18n/index.ts';
import { FULL, ms, setClip } from './ops.ts';

type Patch = Parameters<typeof setClip>[2];

/**
 * The selected clip's numbers (issue 409): where it starts, the used part of its source (a photo: how long it shows),
 * its sound's gain and fades, and on a video track its frame (percent of the output frame) and opacity, with "Fit to
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
          <Num label={t('cutFadeIn')} value={sec(c.fadeIn)} onSet={(v) => apply({ fadeIn: ms(v) || undefined })} />
          <Num label={t('cutFadeOut')} value={sec(c.fadeOut)} onSet={(v) => apply({ fadeOut: ms(v) || undefined })} />
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input type="checkbox" checked={!!c.mute} onChange={(e) => apply({ mute: e.target.checked || undefined })} />
            {t('cutClipMute')}
          </label>
        </>
      )}
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

/** A number applied on Enter or leaving the field; one the edit refuses stays shown, marked, until changed. */
function Num({ label, value, onSet, step = 0.1 }: { label: string; value: number; onSet: (v: number) => boolean; step?: number }) {
  const t = useT();
  const [text, setText] = useState(String(value));
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(String(value)); setBad(false); }, [value]);
  const done = () => {
    const v = Number(text);
    if (text.trim() === '' || !Number.isFinite(v)) return setBad(true);
    if (v === value) return setBad(false);
    setBad(!onSet(v));
  };
  return (
    <label className="flex items-center justify-between gap-2 text-muted-foreground">
      <span className="truncate">{label}</span>
      <input
        type="number" step={step} aria-label={label} value={text} aria-invalid={bad || undefined} title={bad ? t('cutInvalid') : undefined}
        onChange={(e) => setText(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === 'Enter') done(); }}
        className={`h-5 w-20 rounded border bg-background px-1 text-right font-mono text-foreground outline-0 ${bad ? 'border-destructive' : 'border-border-soft'}`}
      />
    </label>
  );
}
