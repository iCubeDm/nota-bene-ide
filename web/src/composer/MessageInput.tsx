import type { ClipboardEventHandler, KeyboardEventHandler, PointerEventHandler, ReactNode, Ref, RefObject } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';

/** The microphone drawn the same in the composer and in the comment popup. */
export function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

/** The mic button of the message field: `tip` is its tooltip (the caller adds the shortcut with `withKey`), `anchor` the box a Whisper prompt points at. */
export function MicButton({ testId, label, tip, disabled, onPointerDown, onClick, anchor, compact }: {
  testId: string; label: string; tip: string; disabled?: boolean; compact?: boolean;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  anchor?: RefObject<HTMLSpanElement | null>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span ref={anchor} className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            data-testid={testId}
            disabled={disabled}
            aria-label={label}
            onPointerDown={onPointerDown}
            onClick={onClick}
            className={`${compact ? 'h-8' : 'h-10'} bg-muted px-2.5 text-muted-foreground hover:text-foreground`}
          >
            <MicIcon />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="whitespace-pre-line">{tip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The message field of the composer and of the comment popup, one component: [leading] [text field] [one action button]
 * [trailing]. The action is the mic while there is nothing to send and Send once there is (`hasContent`), as in a
 * messenger; with no mic (`mic` undefined: no voice on this server) it is always Send. `bar` (a recording) replaces the
 * field and the action. A fragment: the caller's flex row lays the parts out.
 */
export function MessageInput({ textareaRef, id, value, onChange, onKeyDown, onPaste, readOnly, placeholder, ariaLabel, dataShell, fieldClass, compact, overlay, leading, hasContent, mic, send, trailing, bar, children }: {
  textareaRef: Ref<HTMLTextAreaElement>;
  id?: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  readOnly?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  dataShell?: boolean;
  /** extra classes of the textarea (the composer's padding for a cue inside it) */
  fieldClass?: string;
  /** the comment popup's smaller field and buttons */
  compact?: boolean;
  /** cues drawn inside the field (the shell mark, the Tab hint) */
  overlay?: ReactNode;
  /** left of the field (the prompt history) */
  leading?: ReactNode;
  hasContent: boolean;
  mic?: ReactNode;
  send: ReactNode;
  /** after the action (the Stop button) */
  trailing?: ReactNode;
  bar?: ReactNode;
  /** pickers and prompts that belong to the field */
  children?: ReactNode;
}) {
  return (
    <>
      {bar ?? (
        <>
          {leading}
          <div className="relative flex min-w-0 flex-1">
            <textarea
              ref={textareaRef}
              id={id}
              rows={1}
              value={value}
              readOnly={readOnly}
              placeholder={placeholder}
              aria-label={ariaLabel}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              data-shell={dataShell || undefined}
              className={`${compact
                ? 'max-h-[40vh] min-h-16 overflow-y-hidden rounded-md border border-border-soft bg-background px-2 py-1.5 text-[0.8125rem] leading-[1.45] text-foreground focus:border-input-focus focus:ring-2 focus:ring-input-ring focus:outline-none'
                : 'max-h-[40vh] min-h-10 rounded-[10px] border border-border-soft bg-background/70 px-3 py-[9px] text-foreground transition-[border-color,box-shadow] outline-none focus:border-focus-border focus:shadow-[var(--composer-halo)] data-[shell]:border-nb-accent/60 data-[shell]:pr-32 data-[shell]:font-mono data-[shell]:focus:border-nb-accent data-[shell]:focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--nb-accent)_15%,transparent)]'} w-full resize-none ${fieldClass ?? ''}`}
            />
            {overlay}
          </div>
          {children}
          {hasContent || !mic ? send : mic}
        </>
      )}
      {trailing}
    </>
  );
}
