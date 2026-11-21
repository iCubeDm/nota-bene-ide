import { useAutosize } from './autosize.ts';
import { AgentAccount } from '@/controls/AgentAccount.tsx';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT, selectBusy, selectConn, useAppDispatch, useAppSelector, useRegistry, keysLabel, modKey, withKey, chat, sendCount, sendWaiting } from '@/sdk';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@/sdk/ui';
import { CompactClear } from '@/controls/CompactClear.tsx';
import { ModePill } from '@/controls/ModePill.tsx';
import { nextMode, pickMode, selectCapabilities, selectMode, selectSuggestion, selectSwitching } from '@/controls/slice.ts';
import { ShortcodePicker } from '@/comments/ShortcodePicker.tsx';
import { MentionPicker } from './MentionPicker.tsx';
import { SlashPicker } from './SlashPicker.tsx';
import { selectShellMode } from './shellMode.ts';
import { PromptHistory } from './PromptHistory.tsx';
import { MessageInput, MicButton, SendIcon } from './MessageInput.tsx';
import { has } from '@nota-bene/shared';
import { selectPromptItems, selectPromptSid } from './history.ts';
import { usePromptRecall } from './usePromptRecall.ts';
import { useComposerKeys } from './useComposerKeys.ts';
import { Meters } from '@/stats/Meters.tsx';
import { CtxNudge } from '@/stats/CtxNudge.tsx';
import { ComposerAttachments } from '@/attachments/ComposerAttachments.tsx';
import { insertPaths } from '@/attachments/file.ts';
import { hasFiles, useImageIntake } from '@/attachments/useImageIntake.ts';
import { draggedPaths } from '@/files/drag.ts';
import { addImage, selectDraft, selectBuilding, selectImages, selectUploading, setDraft, uploadFinished, uploadStarted } from './slice.ts';
import { VOICE_KEY } from './commands.ts';
import { WhisperPrompt } from '@/voice/WhisperPrompt.tsx';
import { RecordBar } from '@/voice/RecordBar.tsx';
import { onVoiceRefused } from '@/voice/inflight.ts';
import { sendVoice } from '@/voice/send.ts';
import { useVoiceRecorder } from '@/voice/useVoiceRecorder.ts';
import { PLAYER_HELP } from '@/media/playerKeys.ts';
import { useSeekStep } from '@/media/seekStep.ts';

export function Composer() {
  const t = useT();
  const registry = useRegistry();
  const { commands } = registry;
  const seekStep = useSeekStep();
  const dispatch = useAppDispatch();
  const busy = useAppSelector(selectBusy);
  const conn = useAppSelector(selectConn);
  const onAgentTab = useAppSelector((s) => s.tabs.active.startsWith('agent:')); // the message goes to the main agent, not the subagent on screen
  const nPending = useAppSelector((s) => sendCount(registry, s));
  const anyPending = useAppSelector((s) => sendWaiting(registry, s)); // also comments detached from the composer: Send stays on to say why they wait
  const mode = useAppSelector(selectMode);
  const caps = useAppSelector(selectCapabilities);
  const text = useAppSelector(selectDraft);
  const items = useAppSelector(selectPromptItems);
  const sid = useAppSelector(selectPromptSid);
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
  const askForceRef = useRef(false);
  askForceRef.current = askForce;
  useEffect(() => {
    if (!busy) setAskForce(false);
  }, [busy]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fieldBox = useRef<HTMLDivElement>(null);
  // ↑/↓ through the prompts sent before, and a prompt picked in the history list
  const { stepHistory, pickHistory, placeOf, reset: endRecall } = usePromptRecall({ items, sid, text, ref });
  // voice messages: only a server that speaks protocol 14 has the mic; without Whisper it opens Settings → Dictation
  const voiceOk = useAppSelector((s) => has(s.controls.protocol, 'voice'));
  const whisper = caps.dictation === 'whisper';
  const fileIn = useRef<HTMLInputElement>(null);
  // the mic without Whisper asks to set it up in a prompt anchored to the mic
  const [setup, setSetup] = useState(false);
  const micBox = useRef<HTMLSpanElement>(null);
  useEffect(() => { if (whisper) setSetup(false); }, [whisper]);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // the same status spot as "offline": a short-lived note (imgFail / fileFail)
  const flash = (msg: string) => {
    setNote(msg);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 3000);
  };
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  const rec = useVoiceRecorder({
    preview: true,
    notify: flash,
    // sent at once, apart from the draft and the images (they stay where they are); the pending comments ride along
    // false keeps the uploaded recording in the preview: Send hands it over again
    onDone: (v, force) => {
      const ok = dispatch(sendVoice(v, undefined, force, true));
      if (!ok) flash(t('voiceRefused', t(switchingRef.current ? 'switching' : 'offline')));
      return ok;
    },
  });
  const switchingRef = useRef(switching);
  switchingRef.current = switching;
  const recPhase = rec.st.phase;
  const recording = recPhase !== 'idle';
  const recRef = useRef(rec);
  recRef.current = rec;
  // a send the server refused: the recording comes back to the preview (the toast tells why)
  useEffect(() => onVoiceRefused((v) => recRef.current.restore(v)), []);
  // as a typed message: while the agent works Send queues, and the forced send (Cmd/Ctrl) asks before it interrupts
  const voiceSubmit = (force: boolean) => {
    if (switching) return;
    if (force && busy && !askForce) {
      setAskForce(true);
      return;
    }
    setAskForce(false);
    void recRef.current.send(force);
  };
  // Esc closes the question first, then the recording
  const escQuestion = useCallback(() => {
    if (!askForceRef.current) return false;
    setAskForce(false);
    return true;
  }, []);
  const voiceSubmitRef = useRef(voiceSubmit);
  voiceSubmitRef.current = voiceSubmit;
  // the question belongs to the recording: it is gone with it
  useEffect(() => {
    if (recPhase === 'idle') setAskForce(false);
  }, [recPhase]);
  // Alt+R (the keymap): start a voice message, or send the one being made; with Cmd/Ctrl, the forcing send
  useEffect(() => {
    const onKey = (e: Event) => {
      if (!voiceOk) return;
      if (!whisper) return setSetup(true);
      const r = recRef.current;
      if (r.st.phase === 'idle') { if (!switching) r.start(false); } else voiceSubmitRef.current(!!(e as CustomEvent<{ force?: boolean }>).detail?.force);
    };
    document.addEventListener(VOICE_KEY, onKey);
    return () => document.removeEventListener(VOICE_KEY, onKey);
  }, [voiceOk, whisper, switching]);
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
    // any other file (issue 461): its path in the project's attachments/, at the caret
    onFilePath: (p) => { if (ref.current) insertPaths(ref.current, [p]); },
    notify: flash,
    onBusy: (d) => void dispatch(d > 0 ? uploadStarted() : uploadFinished()),
  });

  // the mic shows while the field has no text; an image (also one still uploading) is something to send, as on the phone
  const hasText = !!text.trim();
  const canSend = hasText || images.length > 0 || intake.pending.length > 0 || anyPending;

  // Send goes off once there is nothing left (a send, or the field emptied): keep the caret in the field if the button that
  // had it lost it (a disabled button, or one that finished after its composite images were built)
  const hadSend = useRef(canSend);
  const sendBtn = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (hadSend.current && !canSend) {
      const at = document.activeElement;
      if ((at === document.body || at === sendBtn.current) && !recording) ref.current?.focus({ preventScroll: true });
    }
    hadSend.current = canSend;
  }, [canSend, recording]);

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

  // autosize; max-height (40vh) is applied by CSS. Empty: stay one line — a long placeholder would otherwise wrap and grow the field
  useAutosize(ref, text, !text);

  // a send that failed while offline is forgotten once the socket is back, so a later drop shows no stale label
  useEffect(() => {
    if (conn === 'open') setFailed(false);
  }, [conn]);

  const sendLabel = shellMode ? t('shellRun') : nPending ? t('sendN', nPending) : t('send');
  const submit = (force: boolean) => {
    if (uploading || switching) return;
    if (force && busy && !askForce) {
      setAskForce(true);
      return;
    }
    setAskForce(false);
    endRecall();
    const r = dispatch(chat.send('', { force }));
    if (r === 'empty' || r === 'detached' || r === 'blocked' || r === 'switching' || r === 'building' || r === 'changed') return;
    setFailed(r === 'offline');
    if (r === 'sent') ref.current?.focus();
  };

  const onKeyDown = useComposerKeys({
    ref,
    suggestion: showSug ? suggestion : null,
    pickNextMode: mode && caps.modes.length > 1 ? () => dispatch(pickMode(nextMode(mode, caps.modes))) : null,
    askForce,
    setAskForce,
    stepHistory,
    submit,
  });

  // files dragged from the Files tree (issue 461): their paths at the caret
  const treeOver = (e: React.DragEvent) => {
    if (!draggedPaths(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropping(true);
  };
  const treeDrop = (e: React.DragEvent) => {
    const paths = draggedPaths(e.dataTransfer);
    if (!paths) return;
    e.preventDefault();
    setDropping(false);
    if (ref.current) {
      insertPaths(ref.current, paths);
      ref.current.focus({ preventScroll: true });
    }
  };

  return (
    <div onDragOver={treeOver} onDrop={treeDrop}>
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
          <span>{t('forceAsk', modKey())}</span>
          <span className="grow" />
          <Button type="button" size="sm" variant="destructive" className="h-7" onClick={() => (recording ? voiceSubmit(true) : submit(true))}>
            {t('forceYes')}
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => { setAskForce(false); ref.current?.focus(); }}>
            {t('forceNo')}
          </Button>
        </div>
      )}
      <ComposerAttachments pending={intake.pending} onCancel={intake.cancel} />
      <div data-record-scope data-dropping={dropping || undefined} className="flex items-end gap-2 pt-2.5 pb-1.5 data-[dropping]:rounded-[10px] data-[dropping]:outline data-[dropping]:outline-2 data-[dropping]:outline-dashed data-[dropping]:outline-primary">
        <MessageInput
          textareaRef={ref}
          id="composer-input"
          value={text}
          onChange={(v) => {
            dispatch(setDraft(v));
            setFailed(false);
          }}
          onKeyDown={onKeyDown}
          onPaste={intake.onPaste}
          placeholder={showSug ? suggestion : onAgentTab ? t('composerPhAgent') : t('composerPh')}
          dataShell={shellMode}
          endPad={showSug ? 'pr-28' : undefined}
          fieldClass={showSug ? 'placeholder:text-foreground placeholder:opacity-45' : 'placeholder:truncate'}
          bar={recording ? <RecordBar state={rec.st as Exclude<typeof rec.st, { phase: 'idle' }>} busy={busy} onCancel={rec.cancel} onEscape={escQuestion} onStop={() => void rec.stop()} onSend={voiceSubmit} /> : undefined}
          overlay={<>
            {shellMode && (
              <span aria-hidden data-testid="shell-cue" className="pointer-events-none absolute right-2.5 bottom-2.5 rounded bg-muted px-1.5 py-px font-mono text-[0.65625rem] text-nb-accent">
                {t('shellCue')}
              </span>
            )}
            {showSug && (
              <span aria-hidden className="pointer-events-none absolute right-11 bottom-2.5 rounded bg-muted px-1.5 py-px font-mono text-[0.65625rem] text-muted-foreground">
                Tab ⇥
              </span>
            )}
          </>}
          boxRef={fieldBox}
          leading={<PromptHistory anchor={fieldBox} onPick={pickHistory} onClosed={() => ref.current?.focus({ preventScroll: true })} />}
          // the mic only while the field has no text; Send is always there (off with nothing to send), its badge counts the comments it carries
          hasContent={hasText}
          mic={voiceOk ? (
            <MicButton
              testId="mic"
              anchor={micBox}
              disabled={switching}
              label={t('voiceMic')}
              tip={withKey(t('voiceMic'), 'hk_voice')}
              onPointerDown={micDown}
              onClick={(e) => (whisper ? e.detail === 0 && rec.start(false) : setSetup((o) => !o))}
            />
          ) : undefined}
          // Send and Stop have no tooltip (issue 463): their icons say it; a disabled Send still says why it waits
          send={
            <span className="inline-flex" title={switching ? t('switching') : building ? t('buildingImage') : uploading ? t('uploadWait') : undefined}>
              <Button ref={sendBtn} type="button" className="relative h-10 px-3" disabled={!canSend || uploading || switching} aria-label={sendLabel} onClick={() => submit(false)}>
                <SendIcon count={shellMode ? 0 : nPending} run={shellMode} />
              </Button>
            </span>
          }
          trailing={
            <Button
              type="button"
              variant="ghost"
              disabled={!busy}
              aria-label={t('stopTip')}
              onClick={() => dispatch(chat.interrupt())}
              className="h-10 bg-muted px-2.5 enabled:bg-destructive/15 enabled:text-destructive enabled:hover:bg-destructive/25 disabled:opacity-35"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
              </svg>
            </Button>
          }
        >
          <MentionPicker target={ref} shell={() => shellModeRef.current} />
          <SlashPicker target={ref} suppress={() => placeOf(ref.current?.value ?? '') >= 0} />
          <ShortcodePicker target={ref} />
        </MessageInput>
        {voiceOk && !whisper && <WhisperPrompt open={setup} onOpenChange={setSetup} anchor={hasText ? ref : micBox} />}
      </div>
      <div data-tools-row className="flex min-h-[30px] flex-wrap items-center gap-x-2 gap-y-1 pb-2">
        <input
          ref={fileIn}
          type="file"
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
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('keysTip', modKey())}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" />
                <path d="M12 17h.01" />
              </svg>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="whitespace-pre-line">{`${t('keysTip', modKey())}\n\n${t('hkTitle')}\n${commands.map((b) => `${keysLabel(b)} — ${t(b.id)}`).join('\n')}\n\n${t('pkTitle')}\n${PLAYER_HELP.map(([k, id]) => `${k} — ${t(id, seekStep)}`).join('\n')}`}</TooltipContent>
        </Tooltip>
        <ModePill />
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('attach', modKey())} onClick={() => fileIn.current?.click()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
          </svg>
        </Button>
        <span className="grow" />
        <AgentAccount /><Meters />
        <CompactClear />
      </div>
    </div>
  );
}
