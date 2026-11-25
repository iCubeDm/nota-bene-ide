// Issue 661: one window, one agent. The chat's tab carries ✕, which closes this page's agent after a confirm (issue 636);
// the page then goes to the server's home (issue 639). Another computer's page has none.
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { remotePage, toast, useT } from '@/sdk';
import { ConfirmDialog, Svg } from '@/sdk/ui';
import { nav, PROVIDER_LABEL, reasonText, stopProject, useProjects, type RunningRow } from './api.ts';

export const agentName = (r: RunningRow): string => [PROVIDER_LABEL[r.provider], r.title].filter(Boolean).join(' · ');

/**
 * The close-agent flow, one for the chat's tab and the switcher's agent rows: `ask(row)` opens the confirm (`dialog`), a
 * yes stops the agent; a refusal is a toast, else `after` runs.
 */
export function useAgentClose(after?: () => void): { ask(row: RunningRow): void; dialog: ReactNode } {
  const t = useT();
  const [closing, setClosing] = useState<RunningRow | null>(null);
  const close = async (r: RunningRow) => {
    setClosing(null);
    const why = await stopProject(r);
    if (why) return toast(t('agentClose'), reasonText(why));
    after?.();
  };
  return {
    ask: setClosing,
    dialog: closing && (
      <ConfirmDialog title={t('agentCloseQ')} body={t('agentCloseBody', agentName(closing))} confirm={t('agentClose')} danger
        onConfirm={() => void close(closing)} onCancel={() => setClosing(null)} />
    ),
  };
}

export function AgentClose() {
  const { data } = useProjects(false);
  const { ask, dialog } = useAgentClose(() => nav.go('/'));
  const here = data?.running.find((r) => r.current);
  if (!here?.agent || remotePage()) return null;
  return (
    <>
      <CloseX r={here} onClose={() => ask(here)} />
      {/* the dialog sits in the tab's tree: its clicks, keys and right clicks stay its own */}
      {dialog && <span className="contents" onClick={stop} onKeyDown={stop} onContextMenu={stop}>{dialog}</span>}
    </>
  );
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

/** ✕ of the chat's tab: Enter and Space on it do not reach the tab. */
function CloseX({ r, onClose }: { r: RunningRow; onClose: () => void }) {
  const t = useT();
  return (
    <button type="button" aria-label={`${t('agentClose')}: ${agentName(r)}`} title={t('agentClose')}
      onClick={(e) => { e.stopPropagation(); onClose(); }} onKeyDown={stop}
      className="grid size-[18px] flex-none place-items-center rounded-[5px] text-muted-foreground opacity-50 hover:bg-muted hover:opacity-100">
      <Svg size={10}><path d="M18 6 6 18M6 6l12 12" /></Svg>
    </button>
  );
}
