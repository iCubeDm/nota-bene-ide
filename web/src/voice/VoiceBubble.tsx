import { useState } from 'react';
import type { Voice, VoiceError } from '@nota-bene/shared';
import { Button } from '@/components/ui/button.tsx';
import { useT } from '@/i18n/index.ts';
import { toast } from '@/shell/toast.ts';
import { selectSwitching } from '@/controls/slice.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { sendVoice } from './send.ts';
import { VoiceView } from './VoiceView.tsx';

const ERRORS = { off: 'voiceOff', empty: 'voiceEmpty', failed: 'voiceFailed' } as const;

/** What a recording's text line says: the transcript, "Transcribing…" with a pulsing dot, or why there is none. */
export function Transcript({ text, error, onRetry }: { text?: string; error?: VoiceError; onRetry?: () => void }) {
  const t = useT();
  if (error) {
    return (
      <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-[0.8125rem] text-warn">
        <span>{t(ERRORS[error])}</span>
        {onRetry && <Button type="button" size="xs" variant="outline" onClick={onRetry}>{t('voiceRetry')}</Button>}
      </div>
    );
  }
  if (!text) {
    return (
      <div data-testid="transcribing" className="mt-1 flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-nb-accent" />
        {t('voiceTranscribing')}
      </div>
    );
  }
  return <div data-testid="transcript" className="mt-1 whitespace-pre-wrap text-[0.875rem]">{text}</div>;
}

/**
 * A voice message in the user's bubble: the player, the transcript open under it (the "Aa" button folds it, per bubble
 * and not stored), or "Transcribing…" until the host has it, or the error with Retry (the same voice as a new message).
 */
export function VoiceBubble({ voice, text, error }: { voice: Voice; text?: string; error?: VoiceError }) {
  const t = useT();
  const d = useAppDispatch();
  const [open, setOpen] = useState(true);
  const switching = useAppSelector(selectSwitching);
  // not sent: mid-switch the server refuses sends, which is not "offline"
  const retry = () => { if (!d(sendVoice(voice))) toast(t(switching ? 'switching' : 'offline'), ''); };
  return (
    <div data-voice>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1"><VoiceView voice={voice} /></div>
        {text && !error && (
          <button
            type="button"
            aria-label={t('voiceTextToggle')}
            title={t('voiceTextToggle')}
            aria-pressed={open}
            onClick={() => setOpen((o) => !o)}
            className="flex-none rounded px-1 font-mono text-[0.6875rem] text-muted-foreground hover:bg-muted aria-pressed:text-foreground"
          >
            Aa
          </button>
        )}
      </div>
      {(open || !text || error) && <Transcript text={text} error={error} onRetry={retry} />}
    </div>
  );
}
