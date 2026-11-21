import { useEffect, useRef, useState, type RefObject } from 'react';
import { routes, useResource, useT, useAppDispatch, dictationSet } from '@/sdk';
import { Button, Popover, PopoverAnchor, PopoverContent } from '@/sdk/ui';
import { dictationResource, postDictation } from './dictation.ts';
import { openDictationSettings } from './settings.ts';

/** how often an install in progress is looked at, as Settings does */
const POLL_MS = 2000;

function Body({ close }: { close: () => void }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const got = useResource(dictationResource, undefined, { every: (now) => (now.data?.phase === 'installing' ? POLL_MS : 0) });
  const dict = got.data;
  const [actError, setError] = useState('');
  const error = actError || (got.failed ? got.error ?? '' : '');
  const [busy, setBusy] = useState(false);
  const started = useRef(false); // this prompt began the install: when it is ready, Whisper is switched on for the user
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const act = async (url: string, body?: unknown) => {
    setBusy(true);
    try {
      await postDictation(dispatch, url, body);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    if (alive.current) setBusy(false);
    got.refresh();
  };
  // ready: switched on by the install this prompt started; a server that already has it on only needs the mic told
  useEffect(() => {
    if (!dict || dict.phase !== 'ready') return;
    if (dict.on) {
      dispatch(dictationSet(true));
      close();
    } else if (started.current) {
      started.current = false;
      void act(routes.dictation('on'), { on: true });
    }
  }, [dict]);
  const install = () => { started.current = true; void act(routes.dictation('install')); };

  return (
    <div className="flex w-72 flex-col gap-2.5 p-2.5 text-[0.8125rem]">
      <div className="font-semibold text-foreground">{t('voiceSetupTitle')}</div>
      {dict?.phase === 'none' && <p className="text-muted-foreground">{t('voiceSetupBody', dict.downloadMb, dict.diskMb)}</p>}
      {dict?.phase === 'ready' && !dict.on && <p className="text-muted-foreground">{t('voiceSetupOffBody')}</p>}
      {dict?.phase === 'installing' && (
        <div role="status" className="text-muted-foreground"><span aria-hidden className="mr-1.5 inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />{t('dictInstalling')}</div>
      )}
      {dict?.phase === 'failed' && <span role="alert" className="text-warn">{t('dictFailed')}</span>}
      {error && <span role="alert" className="text-warn">{t('setLoadFail', error)}</span>}
      <div className="flex items-center gap-2">
        {dict?.phase === 'none' && <Button type="button" size="sm" disabled={busy} onClick={install}>{t('dictInstallGo')}</Button>}
        {dict?.phase === 'failed' && <Button type="button" size="sm" disabled={busy} onClick={install}>{t('dictRetry')}</Button>}
        {dict?.phase === 'ready' && !dict.on && <Button type="button" size="sm" disabled={busy} onClick={() => void act(routes.dictation('on'), { on: true })}>{t('voiceSetupOn')}</Button>}
        <span className="grow" />
        <button type="button" className="text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => { close(); openDictationSettings(dispatch); }}>{t('voiceSetupSettings')}</button>
      </div>
    </div>
  );
}

/**
 * The mic without Whisper: a small prompt anchored to the mic. It says Whisper is needed, with the download and disk sizes,
 * and installs it (as Settings → Dictation does), shows the progress and turns it on once ready; if it is installed but off it
 * offers to turn it on. "Open settings" leads to the Dictation section. Esc closes it.
 */
export function WhisperPrompt({ open, onOpenChange, anchor }: { open: boolean; onOpenChange: (open: boolean) => void; anchor: RefObject<HTMLElement | null> }) {
  const t = useT();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchor as RefObject<HTMLElement>} />
      <PopoverContent
        role="dialog"
        data-whisper-prompt
        aria-label={t('voiceSetupTitle')}
        align="end"
        // a press on the mic itself is its own toggle: it must not close the prompt first and reopen it
        onInteractOutside={(e) => { if (anchor.current?.contains(e.target as Node)) e.preventDefault(); }}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <Body close={() => onOpenChange(false)} />
      </PopoverContent>
    </Popover>
  );
}
