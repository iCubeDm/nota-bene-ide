import { useCallback, useEffect, useRef, useState } from 'react';
import type { Voice } from '@nota-bene/shared';
import { useT } from '@/i18n/index.ts';
import { mic, type Recorder, type Recording } from './recorder.ts';
import { uploadVoice } from './upload.ts';

/** A press shorter than this is a click (a locked recording); a longer one records while held and sends on release. */
export const HOLD_MS = 300;
const LEVELS = 48;

export type RecState =
  | { phase: 'idle' }
  /** `held`: the button is still down (release sends); `ms`: the length so far; `levels`: the recent input levels, newest last */
  | { phase: 'recording'; held: boolean; ms: number; levels: number[] }
  /**
   * stopped, to be listened to; `url`: the recording as a playable blob URL ('' where the browser has none);
   * `voice`: it is already uploaded (the send could not go out), so Send does not upload it again
   */
  | { phase: 'preview'; recording: Recording; url: string; voice?: Voice }
  | { phase: 'sending'; recording: Recording; url: string; voice?: Voice };

/**
 * One voice recording at a time, as the composer and the comment popup use it. `onDone` gets the uploaded voice and
 * answers false when it could not use it (offline, mid-switch): the recording then stays in the preview, uploaded, and Send
 * hands the same voice over again. A failed upload keeps the recording in the preview too (Send tries again): a recording
 * is never dropped silently. After an unmount nothing is handed over.
 * `preview`: Stop goes to a preview; without it Stop uploads at once (the comment popup).
 */
export function useVoiceRecorder({ onDone, notify, preview }: { onDone: (v: Voice) => boolean | void; notify: (msg: string) => void; preview: boolean }) {
  const t = useT();
  const [st, setSt] = useState<RecState>({ phase: 'idle' });
  const stRef = useRef(st);
  stRef.current = st;
  const rec = useRef<Recorder | null>(null);
  const gen = useRef(0); // each start moves it: a microphone that opens after a cancel is closed at once
  const t0 = useRef(0);
  const down = useRef(0);
  const afterOpen = useRef<null | 'send' | 'stop'>(null); // a release that came before the microphone had opened
  const alive = useRef(true);
  const cbs = useRef({ onDone, notify, preview, t });
  cbs.current = { onDone, notify, preview, t };

  const put = (s: RecState) => {
    stRef.current = s;
    setSt(s);
  };
  const dropUrl = (s: RecState) => { if ((s.phase === 'preview' || s.phase === 'sending') && s.url) URL.revokeObjectURL?.(s.url); };

  /** uploads (unless it is up already) and hands the voice over; a refusal keeps the recording in the preview */
  const send = useCallback(async (r: Recording, url: string, uploaded?: Voice) => {
    put({ phase: 'sending', recording: r, url, ...(uploaded && { voice: uploaded }) });
    let v = uploaded;
    if (!v) {
      try {
        v = await uploadVoice(r.wav);
      } catch {
        cbs.current.notify(cbs.current.t('voiceUploadFail'));
        if (stRef.current.phase === 'sending') put({ phase: 'preview', recording: r, url });
        return;
      }
    }
    // cancelled or unmounted meanwhile: the host keeps the file, nobody wants it
    if (!alive.current || stRef.current.phase !== 'sending') return;
    if (cbs.current.onDone(v) === false) {
      put({ phase: 'preview', recording: r, url, voice: v });
      return;
    }
    dropUrl(stRef.current);
    put({ phase: 'idle' });
  }, []);

  /** a recording whose send the server refused, back in the preview (nothing to play but the host's copy) */
  const restore = useCallback((v: Voice) => {
    if (stRef.current.phase !== 'idle') return;
    put({ phase: 'preview', recording: { wav: new Blob([], { type: 'audio/wav' }), ms: v.ms, wave: v.wave }, url: '', voice: v });
  }, []);

  /** ends the capture: `send` uploads it, otherwise it goes to the preview */
  const finish = useCallback(async (toSend: boolean) => {
    const r = rec.current;
    if (!r) {
      afterOpen.current = toSend ? 'send' : 'stop';
      return;
    }
    rec.current = null;
    const done = await r.stop();
    if (!done.ms) {
      put({ phase: 'idle' });
      cbs.current.notify(cbs.current.t('voiceNothing')); // nothing was captured: say so, do not just vanish
      return;
    }
    const url = URL.createObjectURL?.(done.wav) ?? '';
    if (toSend || !cbs.current.preview) await send(done, url);
    else put({ phase: 'preview', recording: done, url });
  }, [send]);

  const cancel = useCallback(() => {
    gen.current++;
    afterOpen.current = null;
    rec.current?.cancel();
    rec.current = null;
    dropUrl(stRef.current);
    put({ phase: 'idle' });
  }, []);

  /** Opens the microphone. `held`: the button is down. */
  const start = useCallback((held: boolean) => {
    if (stRef.current.phase !== 'idle') return;
    const g = ++gen.current;
    down.current = Date.now();
    t0.current = Date.now();
    afterOpen.current = null;
    put({ phase: 'recording', held, ms: 0, levels: [] });
    mic.start({
      onLevel: (l) => {
        const cur = stRef.current;
        if (g === gen.current && cur.phase === 'recording') put({ ...cur, levels: [...cur.levels, l].slice(-LEVELS) });
      },
      // the cap ends it as a release does: a held recording is sent, a locked one goes to the preview as Stop does
      onCap: () => {
        const cur = stRef.current;
        if (g === gen.current) void finish(cur.phase === 'recording' && cur.held);
      },
    }).then((r) => {
      if (g !== gen.current) return r.cancel();
      rec.current = r;
      t0.current = Date.now();
      const later = afterOpen.current;
      afterOpen.current = null;
      if (later) void finish(later === 'send');
    }, () => {
      if (g !== gen.current) return;
      put({ phase: 'idle' });
      // no `mediaDevices` at all: a page that is not secure (plain http beyond localhost), where allowing it cannot help
      cbs.current.notify(cbs.current.t(navigator.mediaDevices ? 'voiceDenied' : 'voiceInsecure'));
    });
  }, [finish]);

  /** The button came up: after a long press it sends, after a short one the recording stays on, locked. */
  const release = useCallback(() => {
    const cur = stRef.current;
    if (cur.phase !== 'recording' || !cur.held) return;
    // the microphone not open yet (the permission prompt): the press was not a hold of a recording, so it stays on, locked
    if (rec.current && Date.now() - down.current >= HOLD_MS) void finish(true);
    else put({ ...cur, held: false });
  }, [finish]);

  // the clock
  const recording = st.phase === 'recording';
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      const cur = stRef.current;
      if (cur.phase === 'recording') put({ ...cur, ms: Date.now() - t0.current });
    }, 100);
    return () => clearInterval(id);
  }, [recording]);

  // an unmount drops a recording in progress (the microphone must not stay on)
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => () => {
    gen.current++;
    rec.current?.cancel();
    dropUrl(stRef.current);
  }, []);

  return { st, start, restore, release, cancel, stop: () => finish(false), send: () => {
    const cur = stRef.current;
    if (cur.phase === 'recording') return finish(true);
    if (cur.phase === 'preview') return send(cur.recording, cur.url, cur.voice);
    return Promise.resolve();
  } };
}
