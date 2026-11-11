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

/** The paper plane of every send (the composer's Send, the voice record bar), as in Telegram. */
export const PLANE_PATH = 'M3.4 20.4 21 12 3.4 3.6l-.1 6.5L15 12 3.3 13.9z';
export const PlaneIcon = ({ size = 17 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden><path d={PLANE_PATH} /></svg>
);

/** The plane of the composer's Send; `count` is the comments it carries (a badge, none at 0), `run` swaps it for a terminal prompt (a `!` shell line). */
export function SendIcon({ count, run }: { count: number; run?: boolean }) {
  return (
    <span className="relative inline-flex">
      {run
        ? <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 17l6-6-6-6M12 19h8" /></svg>
        : <PlaneIcon size={18} />}
      {!run && count > 0 && (
        <span aria-hidden data-testid="send-count" className="absolute -top-2 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[0.625rem] leading-none font-semibold text-background">
          {count}
        </span>
      )}
    </span>
  );
}

/** The mic button of the message field: `tip` is its tooltip (the caller adds the shortcut with `withKey`), `anchor` the box a Whisper prompt points at. */
export function MicButton({ testId, label, tip, disabled, onPointerDown, onClick, anchor }: {
  testId: string; label: string; tip: string; disabled?: boolean;
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
            className="h-8 bg-transparent px-2 text-muted-foreground hover:bg-muted hover:text-foreground"
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
 * The message field of the composer and of the comment popup, one component: [leading] [text field] [action]
 * [trailing]. The mic sits inside the field and shows while it has no text (`hasContent` false); the action (Send, Add) is always there, outside. `bar` (a recording) replaces the
 * field and the action. A fragment: the caller's flex row lays the parts out.
 */
export function MessageInput({ textareaRef, id, value, onChange, onKeyDown, onPaste, readOnly, placeholder, ariaLabel, dataShell, fieldClass, compact, overlay, leading, boxRef, endPad, hasContent, mic, send, trailing, bar, children }: {
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
  /** an icon button at the field's left inside edge (the prompt history) */
  leading?: ReactNode;
  /** the bordered field box: what pinned attachments and the history list line up with */
  boxRef?: Ref<HTMLDivElement>;
  /** replaces the textarea's right padding (room for a cue); the default makes room for the mic */
  endPad?: string;
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
          <div
            ref={boxRef}
            data-testid="field-box"
            data-shell={dataShell || undefined}
            // the box carries the border, background and focus ring; the textarea inside is bare
            className={`${compact
              ? 'min-h-16 rounded-md border border-border-soft bg-background focus-within:border-input-focus focus-within:ring-2 focus-within:ring-input-ring'
              : 'min-h-10 rounded-[10px] border border-border-soft bg-background/70 transition-[border-color,box-shadow] focus-within:border-focus-border focus-within:shadow-[var(--composer-halo)] data-[shell]:border-nb-accent/60 data-[shell]:focus-within:border-nb-accent data-[shell]:focus-within:shadow-[0_0_0_3px_color-mix(in_oklch,var(--nb-accent)_15%,transparent)]'} relative flex min-w-0 flex-1`}
          >
            {leading && <span onMouseDown={(e) => e.preventDefault()} className={`absolute ${compact ? 'bottom-0.5 left-0.5' : 'bottom-[3px] left-1'} z-10 inline-flex`}>{leading}</span>}
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
              // the padding is fixed by the icons that may appear, so the text does not reflow when the mic hides
              className={`${compact
                ? `max-h-[40vh] overflow-y-hidden bg-transparent py-1.5 pl-2 ${endPad ?? (mic ? 'pr-10' : 'pr-2')} text-[0.8125rem] leading-[1.45] text-foreground`
                : `max-h-[40vh] bg-transparent py-[9px] ${leading ? 'pl-11' : 'pl-3'} ${endPad ?? (mic ? 'pr-11' : 'pr-3')} text-foreground data-[shell]:pr-32 data-[shell]:font-mono`} ${compact ? 'min-h-[calc(4rem-2px)]' : 'min-h-[calc(2.5rem-2px)]'} w-full min-w-0 resize-none rounded-[inherit] border-0 outline-none focus:outline-none ${fieldClass ?? ''}`}
            />
            {overlay}
            {mic && !hasContent && <span onMouseDown={(e) => e.preventDefault()} className={`absolute ${compact ? 'bottom-0.5 right-0.5' : 'bottom-[3px] right-1'} z-10 inline-flex`}>{mic}</span>}
          </div>
          {children}
          {send}
        </>
      )}
      {trailing}
    </>
  );
}
