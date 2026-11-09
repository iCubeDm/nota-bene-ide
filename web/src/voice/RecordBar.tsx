import { useEffect } from 'react';
import { useT } from '@/i18n/index.ts';
import { clock } from './lang.ts';
import type { RecState } from './useVoiceRecorder.ts';
import { release as releasePlay } from './player.ts';
import { VoiceView } from './VoiceView.tsx';

const ICON = 'size-9 flex-none grid place-items-center rounded-full';
const Cross = () => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>;
const Square = () => <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" /></svg>;
const Plane = () => <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden><path d="M3.4 20.4 21 12 3.4 3.6l-.1 6.5L15 12 3.3 13.9z" /></svg>;
const Trash = () => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>;

/** The live wave: the recent input levels, newest at the right, as bars of 2 px with 1 px gaps. */
function LiveWave({ levels }: { levels: number[] }) {
  return (
    <div data-testid="live-wave" className="flex h-6 min-w-0 flex-1 items-center justify-end gap-px overflow-hidden">
      {levels.map((l, i) => (
        <span key={i} data-bar style={{ height: `${3 + Math.round(Math.sqrt(l) * 19)}px` }} className="w-0.5 flex-none rounded-full bg-primary" />
      ))}
    </div>
  );
}

/**
 * The composer's field while a recording is made: a blinking red dot, the time, the live wave, then Cancel, Stop (to the
 * preview; only with `onStop`) and Send. Stopped: delete, the player and Send. Esc cancels, Enter sends.
 */
export function RecordBar({ state, onCancel, onStop, onSend }: { state: Exclude<RecState, { phase: 'idle' }>; onCancel: () => void; onStop?: () => void; onSend: () => void }) {
  const t = useT();
  const sending = state.phase === 'sending';
  // capture + preventDefault, as the popups do: this Esc must not also reach the document hotkeys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter' && !e.shiftKey && !(e.target as HTMLElement | null)?.closest?.('button')) {
        e.preventDefault();
        onSend();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel, onSend]);
  // the preview's player belongs to this bar: a deleted or sent recording must not play on
  const previewId = state.phase === 'recording' ? null : 'preview';
  useEffect(() => () => { if (previewId) releasePlay(previewId); }, [previewId]);

  if (state.phase === 'recording') {
    return (
      <div data-testid="record-bar" role="group" aria-label={t('voiceRecording')} className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] border border-border-soft bg-background/70 px-2">
        <span aria-hidden className="size-2.5 flex-none animate-pulse rounded-full bg-destructive" />
        <span data-testid="record-time" className="w-10 flex-none font-mono text-sm tabular-nums">{clock(state.ms)}</span>
        <LiveWave levels={state.levels} />
        {!state.held && (
          <>
            <button type="button" aria-label={t('voiceCancel')} title={t('voiceCancel')} onClick={onCancel} className={`${ICON} text-muted-foreground hover:bg-muted hover:text-destructive`}><Cross /></button>
            {onStop && <button type="button" aria-label={t('voiceStop')} title={t('voiceStop')} onClick={onStop} className={`${ICON} text-destructive hover:bg-destructive/15`}><Square /></button>}
            <button type="button" aria-label={t('voiceSendTip')} title={t('voiceSendTip')} onClick={onSend} className={`${ICON} bg-primary text-primary-foreground hover:opacity-90`}><Plane /></button>
          </>
        )}
      </div>
    );
  }
  const { recording } = state;
  return (
    <div data-testid="record-bar" role="group" aria-label={t('voiceRecording')} aria-busy={sending || undefined} className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] border border-border-soft bg-background/70 px-2">
      <button type="button" aria-label={t('voiceCancel')} title={t('voiceCancel')} disabled={sending} onClick={onCancel} className={`${ICON} text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-40`}><Trash /></button>
      <div className="min-w-0 flex-1">
        <VoiceView voice={{ id: 'preview', ms: recording.ms, wave: recording.wave }} src={state.url || undefined} />
      </div>
      <button type="button" aria-label={t('voiceSendTip')} title={t('voiceSendTip')} disabled={sending} onClick={onSend} className={`${ICON} bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50`}>
        {sending ? <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Plane />}
      </button>
    </div>
  );
}
