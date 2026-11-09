import { AgentAccount } from '@/controls/AgentAccount.tsx';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { useT } from '@/i18n/index.ts';
import { sendBatch } from '@/comments/send.ts';
import { selectPending } from '@/comments/slice.ts';
import { CompactClear } from '@/controls/CompactClear.tsx';
import { ModePill } from '@/controls/ModePill.tsx';
import { nextMode, pickMode, selectCapabilities, selectMode, selectSuggestion, selectSwitching } from '@/controls/slice.ts';
import { ShortcodePicker } from '@/comments/ShortcodePicker.tsx';
import { MentionPicker } from './MentionPicker.tsx';
import { SlashPicker } from './SlashPicker.tsx';
import { selectShellMode } from './shellMode.ts';
import { Meters } from '@/stats/Meters.tsx';
import { CtxNudge } from '@/stats/CtxNudge.tsx';
import { Attachments } from '@/attachments/Attachments.tsx';
import { hasFiles, useImageIntake } from '@/attachments/useImageIntake.ts';
import { addImage, removeImage, selectDraft, selectBuilding, selectImages, selectUploading, setDraft, uploadFinished, uploadStarted } from './slice.ts';
import { interrupt, selectBusy, selectConn, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { BINDINGS, keysLabel, VOICE_KEY, withKey } from '@/shell/keymap.ts';
import { openSettings } from '@/tabs/slice.ts';
import { RecordBar } from '@/voice/RecordBar.tsx';
import { sendVoice } from '@/voice/send.ts';
import { useVoiceRecorder } from '@/voice/useVoiceRecorder.ts';
import { PLAYER_HELP } from '@/media/playerKeys.ts';
import { useSeekStep } from '@/media/seekStep.ts';

export function Composer() {
  const t = useT();
  const seekStep = useSeekStep();
  const dispatch = useAppDispatch();
  const busy = useAppSelector(selectBusy);
  const conn = useAppSelector(selectConn);
  const onAgentTab = useAppSelector((s) => s.tabs.active.startsWith('agent:')); // the message goes to the main agent, not the subagent on screen
  const nPending = useAppSelector(selectPending).length;
  const mode = useAppSelector(selectMode);
  const caps = useAppSelector(selectCapabilities);
  const text = useAppSelector(selectDraft);
  const images = useAppSelector(selectImages);
  const building = useAppSelector(selectBuilding);
  const uploading = useAppSelector(selectUploading) > 0 || building;
  // mid-switch the server refuses sends: Send is off (Enter too) and the draft simply waits for the new session
  const switching = useAppSelector(selectSwitching);
  const suggestion = useAppSelector(selectSuggestion);
  const shellMode = useAppSelector(selectShellMode); // a one-line draft that starts with `!` is a shell command: Enter runs it
  const shellModeRef = useRef(shellMode);
  shellModeRef.current = shellMode;
  const showSug = !!suggestion && !text && !busy && !switching;
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState('');
  const [dropping, setDropping] = useState(false);
  // Cmd/Ctrl+Enter while the agent works would interrupt it: the first press only asks, a second one (or the button) confirms
  const [askForce, setAskForce] = useState(false);
  useEffect(() => {
    if (!busy) setAskForce(false);
  }, [busy]);
  const ref = useRef<HTMLTextAreaElement>(null);
  // voice messages: only a server that speaks protocol 14 has the mic; without Whisper it opens Settings → Dictation
  const voiceOk = useAppSelector((s) => s.controls.protocol >= 14);
  const whisper = caps.dictation === 'whisper';
  const fileIn = useRef<HTMLInputElement>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // the same status spot as "offline": a short-lived note (onlyImages / imgFail)
  const flash = (msg: string) => {
    setNote(msg);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 3000);
  };
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  const rec = useVoiceRecorder({
    preview: true,
    notify: flash,
    // sent at once, apart from the draft, the images and the pending comments (they stay where they are)
    onDone: (v) => { if (!dispatch(sendVoice(v))) flash(t('voiceRefused', t('offline'))); },
  });
  const recPhase = rec.st.phase;
  const recording = recPhase !== 'idle';
  const recRef = useRef(rec);
  recRef.current = rec;
  // Alt+R (the keymap): start a voice message, or send the one being made
  useEffect(() => {
    const onKey = () => {
      if (!voiceOk) return;
      if (!whisper) return void dispatch(openSettings());
      const r = recRef.current;
      if (r.st.phase === 'idle') { if (!switching) r.start(false); } else void r.send();
    };
    document.addEventListener(VOICE_KEY, onKey);
    return () => document.removeEventListener(VOICE_KEY, onKey);
  }, [voiceOk, whisper, switching, dispatch]);
  // back to typing after a recording: the caret returns to the field
  const wasRecording = useRef(false);
  useEffect(() => {
    if (recPhase === 'idle' && wasRecording.current) ref.current?.focus({ preventScroll: true });
    wasRecording.current = recPhase !== 'idle';
  }, [recPhase]);
  const micDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !whisper || switching || recRef.current.st.phase !== 'idle') return;
    recRef.current.start(true);
    // the button is gone from under the finger once the bar replaces it: the release is read on the window
    const up = () => { window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); recRef.current.release(); };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const intake = useImageIntake({
    onUploaded: (im) => void dispatch(addImage(im)),
    notify: flash,
    onBusy: (d) => void dispatch(d > 0 ? uploadStarted() : uploadFinished()),
  });

  // drop anywhere in the window attaches to the message (a drop inside an open comment popup is taken there first)
  const addRef = useRef(intake.add);
  addRef.current = intake.add;
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(true);
    };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDropping(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(false);
      addRef.current(e.dataTransfer?.files ?? []);
    };
    // capture: a drop taken (and stopped) by the comment popup must still clear the highlight
    const clear = () => setDropping(false);
    document.addEventListener('drop', clear, true);
    document.addEventListener('dragend', clear, true);
    document.addEventListener('dragover', over);
    document.addEventListener('dragleave', leave);
    document.addEventListener('drop', drop);
    return () => {
      document.removeEventListener('drop', clear, true);
      document.removeEventListener('dragend', clear, true);
      document.removeEventListener('dragover', over);
      document.removeEventListener('dragleave', leave);
      document.removeEventListener('drop', drop);
    };
  }, []);

  // autosize; max-height (40vh) is applied by CSS
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // empty: stay one line — a long placeholder would otherwise wrap and grow the field (prototype clips it)
    if (text) el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // a send that failed while offline is forgotten once the socket is back, so a later drop shows no stale label
  useEffect(() => {
    if (conn === 'open') setFailed(false);
  }, [conn]);

  const submit = (force: boolean) => {
    if (uploading || switching) return;
    if (force && busy && !askForce) {
      setAskForce(true);
      return;
    }
    setAskForce(false);
    const r = dispatch(sendBatch(force));
    if (r === 'empty' || r === 'blocked' || r === 'switching' || r === 'building' || r === 'changed') return;
    setFailed(r === 'offline');
    if (r === 'sent') ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // an open @ / : / picker takes Tab at window capture and stops it, so this is only reached with no picker to serve
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.nativeEvent.isComposing && showSug) {
      e.preventDefault();
      dispatch(setDraft(suggestion));
      // the controlled value lands on the next render; put the caret after it
      requestAnimationFrame(() => ref.current?.setSelectionRange(suggestion.length, suggestion.length));
      return;
    }
    if (e.key === 'Tab' && e.shiftKey && !e.nativeEvent.isComposing && mode && caps.modes.length > 1) {
      e.preventDefault();
      dispatch(pickMode(nextMode(mode, caps.modes)));
      return;
    }
    if (e.key === 'Escape' && askForce) {
      e.preventDefault(); // the document hotkeys skip it
      setAskForce(false);
      return;
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const force = e.metaKey || e.ctrlKey;
    if (e.shiftKey && !force) return;
    e.preventDefault();
    submit(force);
  };

  return (
    <div>
      <div className="flex min-h-0 items-center gap-2.5 pt-2 text-xs text-muted-foreground">
        {busy && (
          <>
            <span className="animate-pulse text-nb-accent">●</span>
            {t('working')}
          </>
        )}
        {failed && conn !== 'open' && <span className="text-warn">{t('offline')}</span>}
        {note && <span className="text-warn">{note}</span>}
        <CtxNudge />
      </div>
      {askForce && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-foreground">
          <span>{t('forceAsk')}</span>
          <span className="grow" />
          <Button type="button" size="sm" variant="destructive" className="h-7" onClick={() => submit(true)}>
            {t('forceYes')}
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => { setAskForce(false); ref.current?.focus(); }}>
            {t('forceNo')}
          </Button>
        </div>
      )}
      <Attachments
        data-testid="composer-thumbs"
        ids={images.map((i) => i.id)}
        pending={intake.pending}
        onRemove={(id) => void dispatch(removeImage(id))}
      />
      <div data-dropping={dropping || undefined} className="flex items-end gap-2 pt-2.5 pb-1.5 data-[dropping]:rounded-[10px] data-[dropping]:outline data-[dropping]:outline-2 data-[dropping]:outline-dashed data-[dropping]:outline-primary">
        {recording ? <RecordBar state={rec.st as Exclude<typeof rec.st, { phase: 'idle' }>} onCancel={rec.cancel} onStop={() => void rec.stop()} onSend={() => void rec.send()} /> : (<>
        <div className="relative flex min-w-0 flex-1">
        <textarea
          ref={ref}
          id="composer-input"
          rows={1}
          value={text}
          placeholder={showSug ? suggestion : onAgentTab ? t('composerPhAgent') : t('composerPh')}
          onChange={(e) => {
            dispatch(setDraft(e.target.value));
            setFailed(false);
          }}
          onKeyDown={onKeyDown}
          onPaste={intake.onPaste}
          data-shell={shellMode || undefined}
          className={`max-h-[40vh] min-h-10 w-full resize-none rounded-[10px] border border-border-soft bg-background/70 px-3 py-[9px] text-foreground transition-[border-color,box-shadow] outline-none focus:border-focus-border focus:shadow-[var(--composer-halo)] data-[shell]:border-nb-accent/60 data-[shell]:pr-32 data-[shell]:font-mono data-[shell]:focus:border-nb-accent data-[shell]:focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--nb-accent)_15%,transparent)] ${showSug ? 'pr-16 placeholder:text-foreground placeholder:opacity-45' : 'placeholder:truncate'}`}
        />
        {shellMode && (
          <span aria-hidden data-testid="shell-cue" className="pointer-events-none absolute right-2.5 bottom-2.5 rounded bg-muted px-1.5 py-px font-mono text-[0.65625rem] text-nb-accent">
            {t('shellCue')}
          </span>
        )}
        {showSug && (
          <span aria-hidden className="pointer-events-none absolute right-2.5 bottom-2.5 rounded bg-muted px-1.5 py-px font-mono text-[0.65625rem] text-muted-foreground">
            Tab ⇥
          </span>
        )}
        </div>
        <MentionPicker target={ref} shell={() => shellModeRef.current} />
        <SlashPicker target={ref} />
        <ShortcodePicker target={ref} />
        </>)}
        {voiceOk && !recording && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="ghost"
                  data-testid="mic"
                  disabled={switching}
                  aria-label={whisper ? t('voiceMic') : t('voiceMicSetup')}
                  onPointerDown={micDown}
                  onClick={(e) => (whisper ? e.detail === 0 && rec.start(false) : void dispatch(openSettings()))}
                  className="h-10 bg-muted px-2.5 text-muted-foreground hover:text-foreground"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="9" y="3" width="6" height="11" rx="3" />
                    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                  </svg>
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent className="whitespace-pre-line">{withKey(whisper ? t('voiceMic') : t('voiceMicSetup'), 'hk_voice')}</TooltipContent>
          </Tooltip>
        )}
        {!recording && (
          <span className="inline-flex" title={switching ? t('switching') : building ? t('buildingImage') : uploading ? t('uploadWait') : undefined}>
            <Button type="button" className="h-10" disabled={uploading || switching} onClick={() => submit(false)}>
              {shellMode ? t('shellRun') : nPending ? t('sendN', nPending) : t('send')}
            </Button>
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              disabled={!busy}
              aria-label={t('stopTip')}
              onClick={() => dispatch(interrupt())}
              className="h-10 bg-muted px-2.5 enabled:bg-destructive/15 enabled:text-destructive enabled:hover:bg-destructive/25 disabled:opacity-35"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
              </svg>
            </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="whitespace-pre-line">{t('stopTip')}</TooltipContent>
        </Tooltip>
      </div>
      <div data-tools-row className="flex min-h-[30px] flex-wrap items-center gap-x-2 gap-y-1 pb-2">
        <input
          ref={fileIn}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => {
            intake.add(e.target.files ?? []);
            e.target.value = '';
          }}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('keysTip')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" />
                <path d="M12 17h.01" />
              </svg>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="whitespace-pre-line">{`${t('keysTip')}\n\n${t('hkTitle')}\n${BINDINGS.map((b) => `${keysLabel(b)} — ${t(b.id)}`).join('\n')}\n\n${t('pkTitle')}\n${PLAYER_HELP.map(([k, id]) => `${k} — ${t(id, seekStep)}`).join('\n')}`}</TooltipContent>
        </Tooltip>
        <ModePill />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('attach')} onClick={() => fileIn.current?.click()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
              </svg>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="whitespace-pre-line">{t('attach')}</TooltipContent>
        </Tooltip>
        <span className="grow" />
        <AgentAccount /><Meters />
        <CompactClear />
      </div>
    </div>
  );
}
