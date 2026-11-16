import { useState } from 'react';
import type { Cut } from '@nota-bene/shared/cut';
import { useT } from '@/i18n/index.ts';
import type { Lane } from './layout.ts';
import { moveTrack, removeTrack, renameTrack, setTrackFlag } from './ops.ts';

const dB = (g: number) => `${g > 0 ? '+' : g < 0 ? '−' : ''}${Math.abs(g)} dB`;
const BTN = 'grid h-4 min-w-4 place-items-center rounded px-0.5 font-mono text-[0.625rem] leading-none hover:bg-muted hover:text-foreground';

/**
 * An editable track's header (issue 409): its name (a double-click renames it), mute, solo and (a video track) hidden
 * as toggles, up and down among the tracks of its kind, and remove (with its clips; undo brings them back).
 */
export function TrackHead({ lane: l, cut, commit, width }: { lane: Lane; cut: Cut; commit: (c: Cut) => void; width: number }) {
  const t = useT();
  const [naming, setNaming] = useState<string | null>(null);
  const shown = l.name ?? t(l.kind === 'video' ? 'cutVideoN' : 'cutAudioN', l.n);
  const done = () => {
    if (naming !== null && naming.trim() !== (l.name ?? '')) commit(renameTrack(cut, l.id, naming));
    setNaming(null);
  };
  const flag = (key: 'mute' | 'solo' | 'hidden', label: string, letter: string) => (
    <button
      type="button" aria-label={label} title={label} aria-pressed={!!l[key]}
      onClick={() => commit(setTrackFlag(cut, l.id, key, !l[key]))}
      className={`${BTN} ${l[key] ? 'bg-primary/25 text-foreground' : ''}`}
    >{letter}</button>
  );
  const act = (label: string, glyph: string, next: () => Cut) => (
    <button type="button" aria-label={label} title={label} onClick={() => { const c = next(); if (c !== cut) commit(c); }} className={BTN}>{glyph}</button>
  );
  return (
    <div data-track-head={l.id} className="sticky left-0 z-20 flex flex-none flex-col justify-center gap-0.5 border-r border-border-soft bg-chrome px-2 text-xs" style={{ width }}>
      {naming !== null ? (
        <input
          aria-label={t('cutTrackName')} value={naming} autoFocus onChange={(e) => setNaming(e.target.value)} onBlur={done}
          onKeyDown={(e) => { if (e.key === 'Enter') done(); else if (e.key === 'Escape') setNaming(null); }}
          className="h-5 min-w-0 rounded border border-input-focus-soft bg-background px-1 text-xs text-foreground outline-0"
        />
      ) : (
        <span data-track-name className="cursor-text truncate text-foreground" title={t('cutRenameTip')} onDoubleClick={() => setNaming(l.name ?? '')}>{shown}</span>
      )}
      <span className="flex items-center gap-0.5 text-muted-foreground">
        {flag('mute', t('cutTrackMute'), t('cutMuteShort'))}
        {flag('solo', t('cutTrackSolo'), t('cutSoloShort'))}
        {l.kind === 'video' && flag('hidden', t('cutTrackHide'), t('cutHideShort'))}
        {l.gain !== undefined && l.gain !== 0 && <span className="font-mono text-[0.625rem]">{dB(l.gain)}</span>}
        <span className="flex-1" />
        {act(t('cutTrackUp'), '↑', () => moveTrack(cut, l.id, -1))}
        {act(t('cutTrackDown'), '↓', () => moveTrack(cut, l.id, 1))}
        {act(t('cutTrackRemove'), '×', () => removeTrack(cut, l.id))}
      </span>
    </div>
  );
}
