import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx';

/**
 * One tool-window button of the strips: an icon that toggles its panel, the name in a tooltip on the panel's side
 * (`tip`: the name with its key, `withKey`). Pressed, it is --tool-on while its panel has the focus and --tool-on-idle
 * otherwise (IntelliJ's blue and grey).
 */
export function ToolButton({ id, label, tip = label, pressed, focused, side, onClick, children }: {
  id: string; label: string; tip?: string; pressed: boolean; focused: boolean; side: 'left' | 'right'; onClick: () => void; children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          id={id}
          aria-pressed={pressed}
          aria-label={label}
          data-focused={focused}
          onClick={onClick}
          className={`relative grid size-[28px] place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground ${pressed ? (focused ? 'bg-tool-on text-tool-on-fg hover:text-tool-on-fg' : 'bg-tool-on-idle text-tool-on-idle-fg hover:text-tool-on-idle-fg') : ''}`}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side === 'left' ? 'right' : 'left'}>{tip}</TooltipContent>
    </Tooltip>
  );
}
