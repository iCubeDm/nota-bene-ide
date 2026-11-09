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
  /** stopped, to be listened to; `url`: the recording as a playable blob URL ('' where the browser has none) */
  | { phase: 'preview'; recording: Recording; url: string }
  | { phase: 'sending'; recording: Recording; url: string };

/**
 * One voice recording at a time, as the composer and the comment popup use it. `onDone` gets the uploaded voice. A
 * failed upload keeps the recording in the preview (Send tries again): a recording is never dropped silently.
 * `preview`: Stop goes to a preview; without it Stop uploads at once (the comment popup).
 */
export function useVoiceRecorder({ onDone, notify, preview }: { onDone: (v: Voice) => void; notify: (msg: string) => void; preview: boolean }) {
  const t = useT();
  const [st, setSt] = useState<RecState>({ phase: 'idle' });
  const stRef = useRef(st);
  stRef.current = st;
  const rec = useRef<Recorder | null>(null);
  const gen = useRef(0); // each start moves it: a microphone that opens after a cancel is closed at once
  const t0 = useRef(0);
  const down = useRef(0);
  const afterOpen = useRef<null | 'send' | 'stop'>(null); // a release that came before the microphone had opened
  const cbs = useRef({ onDone, notify, preview, t });
  cbs.current = { onDone, notify, preview, t };

  const put = (s: RecState) => {
    stRef.current = s;
    setSt(s);
  };
  const dropUrl = (s: RecState) => { if ((s.phase === 'preview' || s.phase === 'sending') && s.url) URL.revokeObjectURL?.(s.url); };

  const send = useCallback(async (r: Recording, url: string) => {
    put({ phase: 'sending', recording: r, url });
    try {
      const v = await uploadVoice(r.wav);
      if (stRef.current.phase !== 'sending') return; // cancelled meanwhile (unmounted): the host keeps the file, nobody wants it
      dropUrl(stRef.current);
      put({ phase: 'idle' });
      cbs.current.onDone(v);
    } catch {
      cbs.current.notify(cbs.current.t('voiceUploadFail'));
      if (stRef.current.phase === 'sending') put({ phase: 'preview', recording: r, url });
    }
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
      put({ phase: 'idle' }); // nothing was captured
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
      onCap: () => { if (g === gen.current) void finish(true); }, // the cap ends it as a release does
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
      cbs.current.notify(cbs.current.t('voiceDenied'));
    });
  }, [finish]);

  /** The button came up: after a long press it sends, after a short one the recording stays on, locked. */
  const release = useCallback(() => {
    const cur = stRef.current;
    if (cur.phase !== 'recording' || !cur.held) return;
    if (Date.now() - down.current >= HOLD_MS) void finish(true);
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
  useEffect(() => () => {
    gen.current++;
    rec.current?.cancel();
    dropUrl(stRef.current);
  }, []);

  return { st, start, release, cancel, stop: () => finish(false), send: () => {
    const cur = stRef.current;
    if (cur.phase === 'recording') return finish(true);
    if (cur.phase === 'preview') return send(cur.recording, cur.url);
    return Promise.resolve();
  } };
}
