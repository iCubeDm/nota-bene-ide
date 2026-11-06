import type { AgentMode as Mode } from '@nota-bene/shared';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { pickMode, selectCapabilitiesKnown, selectMode, selectSwitching } from './slice.ts';

// colours as in the CLI's mode line (prototype #modeBtn.m-*)
const TONE: Partial<Record<Mode, string>> = {
  default: 'text-muted-foreground border-border-soft',
  acceptEdits: 'text-link border-primary/45',
  plan: 'text-hue-17 border-hue-18/45',
  auto: 'text-hue-19 border-hue-20/40',
};

export function ModePill() {
  const t = useT();
  const dispatch = useAppDispatch();
  const mode = useAppSelector(selectMode);
  const switching = useAppSelector(selectSwitching); // the switch announces the new session's mode
  const caps = useAppSelector(selectCapabilitiesKnown);
  const modes = caps?.modes ?? [];
  const label = (m: Mode) => (caps?.provider !== 'codex' ? caps?.modeDescriptors?.find((d) => d.id === m)?.name : undefined) ?? t(`mode_${m}`);
  const description = (m: Mode) => (caps?.provider !== 'codex' ? caps?.modeDescriptors?.find((d) => d.id === m)?.description : undefined) ?? t(`mode_${m}_desc`);
  // unknown until the server says; and with fewer than two modes there is nothing to choose
  if (!mode || modes.length < 2) return null;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('modeTip')}
              disabled={switching}
              className={`inline-flex h-[26px] items-center gap-1.5 rounded-full border bg-transparent px-2.5 text-xs font-medium enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50 ${TONE[mode] ?? TONE.default}`}
            >
              <span aria-hidden className="size-[7px] rounded-full bg-current opacity-80" />
              {label(mode)}
            </button>
          </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent className="whitespace-pre-line">{t('modeTip')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" className="w-[340px]">
        {modes.map((m) => (
          <DropdownMenuItem
            key={m}
            aria-current={m === mode || undefined}
            onSelect={() => void dispatch(pickMode(m))}
            className={`block px-2.5 py-[7px] ${m === mode ? 'bg-muted' : ''}`}
          >
            <b className="block text-[0.8125rem] font-medium">{label(m)}</b>
            <span className="mt-0.5 block text-[0.71875rem] leading-snug text-muted-foreground">{description(m)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
