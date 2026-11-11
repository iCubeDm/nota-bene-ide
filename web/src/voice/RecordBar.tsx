import { useEffect, useId, useRef } from 'react';
import { PlaneIcon } from '@/composer/MessageInput.tsx';
import { useT } from '@/i18n/index.ts';
import { BINDINGS, isMac, keysLabel } from '@/shell/keymap.ts';
import { clock } from './lang.ts';
import type { RecState } from './useVoiceRecorder.ts';
import { release as releasePlay } from './player.ts';
import { VoiceView } from './VoiceView.tsx';

/** Cmd or Ctrl: Send with it forces, as the typed Enter does (the composer takes either on every platform). */
const forcing = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey;

/** The Send button's tooltip: its keys, and while the agent works what queues and what interrupts. */
function useSendTip(busy: boolean): string {
  const t = useT();
  const alt = keysLabel(BINDINGS.find((b) => b.id === 'hk_voice')!);
  const mod = isMac() ? '⌘' : 'Ctrl+';
  const tip = t('voiceSendTip', alt);
  return busy ? `${tip}\n${t('voiceSendBusyTip', `${mod}Enter`, `${mod}${alt}`)}` : tip;
}

/** The bars that are mounted, oldest first: a key nobody has focus for (the page body) belongs to the newest only. */
const mounted: object[] = [];

const ICON = 'size-9 flex-none grid place-items-center rounded-full';
const Cross = () => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>;
const Square = () => <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" /></svg>;
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
 * preview; only with `onStop`) and Send. Stopped: delete, the player and Send. Esc cancels (`onEscape` may take it first), Enter sends. While `busy`
 * the agent works and Send queues the message; Cmd/Ctrl with Enter or a click on Send calls `onSend(true)`: the forced one.
 * `clip`: a comment's recording: the one button after Cancel is Stop, which adds the clip (no preview, nothing is sent).
 */
export function RecordBar({ state, onCancel, onStop, onSend, clip = false, busy = false, onEscape }: { state: Exclude<RecState, { phase: 'idle' }>; onCancel: () => void; onStop?: () => void; onSend: (force: boolean) => void; clip?: boolean; busy?: boolean; onEscape?: () => boolean }) {
  const t = useT();
  const sendTip = useSendTip(busy && !clip);
  const sending = state.phase === 'sending';
  const root = useRef<HTMLDivElement>(null);
  const me = useRef({}).current;
  useEffect(() => {
    mounted.push(me);
    return () => void mounted.splice(mounted.indexOf(me), 1);
  }, [me]);
  const live = state.phase === 'recording';
  // capture + preventDefault, as the popups do: this Esc must not also reach the document hotkeys. But a key another layer
  // took (defaultPrevented: a closed menu or dialog) is not ours, and nor is one from a control outside this bar's row
  // (`data-record-scope`, else the bar itself). With no focus at all (the page body) a recording's bar takes it, the newest
  // one only; a stopped recording is deleted by Esc only with focus inside the bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      const target = e.target as Node | null;
      const own = !!target && !!root.current && (root.current.contains(target) || !!root.current.closest('[data-record-scope]')?.contains(target));
      const bare = !target || target === document.body || target === document.documentElement || target === document;
      const isBar = target instanceof Element && root.current?.contains(target);
      if (e.key === 'Escape') {
        if (!(own || (bare && live && mounted[mounted.length - 1] === me))) return;
        if (!live && !isBar) return;
        e.preventDefault();
        if (!onEscape?.()) onCancel();
      } else if (e.key === 'Enter' && !e.shiftKey && !(e.target as HTMLElement | null)?.closest?.('button, textarea, input, [contenteditable]')) {
        if (!(own || (bare && mounted[mounted.length - 1] === me))) return;
        e.preventDefault();
        onSend(forcing(e));
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel, onEscape, onSend, live, me]);
  // the stopped recording takes focus (the Stop button it came from is gone), so Esc and Enter keep working on it
  useEffect(() => {
    const a = document.activeElement;
    if (!live && root.current && (!a || a === document.body)) root.current.focus({ preventScroll: true });
  }, [live]);
  // the preview's player belongs to this bar: a deleted or sent recording must not play on
  const uid = useId();
  // its own element: another preview (the comment popup's) must not share it; an uploaded recording is the host's one
  const previewId = state.phase === 'recording' ? null : state.voice?.id ?? `preview:${uid}`;
  useEffect(() => () => { if (previewId) releasePlay(previewId); }, [previewId]);

  if (state.phase === 'recording') {
    return (
      <div ref={root} tabIndex={-1} data-testid="record-bar" role="group" aria-label={t('voiceRecording')} className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] outline-none border border-border-soft bg-background/70 px-2">
        <span aria-hidden className="size-2.5 flex-none animate-pulse rounded-full bg-destructive" />
        <span data-testid="record-time" className="w-10 flex-none font-mono text-sm tabular-nums">{clock(state.ms)}</span>
        <LiveWave levels={state.levels} />
        {!state.held && (
          <>
            <button type="button" aria-label={t('voiceCancel')} title={t('voiceCancel')} onClick={onCancel} className={`${ICON} text-muted-foreground hover:bg-muted hover:text-destructive`}><Cross /></button>
            {onStop && <button type="button" aria-label={t('voiceStop')} title={t('voiceStop')} onClick={onStop} className={`${ICON} text-destructive hover:bg-destructive/15`}><Square /></button>}
            <button type="button" aria-label={clip ? t('voiceClipStop') : t('voiceSendLabel')} title={clip ? t('voiceClipStop') : sendTip} onClick={(e) => onSend(forcing(e))} className={`${ICON} bg-primary text-primary-foreground hover:opacity-90`}>{clip ? <Square /> : <PlaneIcon />}</button>
          </>
        )}
      </div>
    );
  }
  const { recording } = state;
  return (
    <div ref={root} tabIndex={-1} data-testid="record-bar" role="group" aria-label={t('voiceRecording')} aria-busy={sending || undefined} className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] outline-none border border-border-soft bg-background/70 px-2">
      <button type="button" aria-label={t('voiceCancel')} title={t('voiceCancel')} disabled={sending} onClick={onCancel} className={`${ICON} text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-40`}><Trash /></button>
      <div className="min-w-0 flex-1">
        <VoiceView voice={{ id: previewId!, ms: recording.ms, wave: recording.wave }} src={state.url || undefined} />
      </div>
      <button type="button" aria-label={t('voiceSendLabel')} title={sendTip} disabled={sending} onClick={(e) => onSend(forcing(e))} className={`${ICON} bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50`}>
        {sending ? <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <PlaneIcon />}
      </button>
    </div>
  );
}
