import type { Voice, VoiceError } from '@nota-bene/shared';
import { useT } from '@/i18n/index.ts';
import { Transcript } from './VoiceBubble.tsx';
import { VoiceView } from './VoiceView.tsx';

/**
 * One recording of a comment: the player, its transcript (or "Transcribing…", or the error with Retry) and, in the
 * editor, a delete button. In a sent or saved comment there is no delete and the transcript is what the agent got.
 */
export function ClipRow({ voice, text, error, onRetry, onDelete }: { voice: Voice; text?: string; error?: VoiceError; onRetry?: () => void; onDelete?: () => void }) {
  const t = useT();
  return (
    <div data-clip className="flex items-start gap-2 rounded-md bg-muted/50 px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <VoiceView voice={voice} />
        <Transcript text={text} error={error} onRetry={onRetry} />
      </div>
      {onDelete && (
        <button
          type="button"
          aria-label={t('voiceClipDelete')}
          title={t('voiceClipDelete')}
          onClick={onDelete}
          className="grid size-6 flex-none place-items-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      )}
    </div>
  );
}
