import type { ComponentProps } from 'react';
import { useT, useAppDispatch, useAppSelector, openAgent, isAgentTool, type ToolRenderer, selectCallEnd, selectLiveCalls, selectSubagent } from '@/sdk';
import { CardMenu } from '@/tasks/CardMenu.tsx';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The head of a subagent's call (Agent, or Task in older Claude Code): a card with its type, what it was asked, its
 * status and an «open» button for its conversation tab. The chevron still folds the call's own input and output, so
 * both stay commentable like any action's.
 */
export function AgentCard({ item, open, panelId, comments, busy, onToggle }: ComponentProps<ToolRenderer['render']>) {
  const t = useT();
  const dispatch = useAppDispatch();
  const sub = useAppSelector((s) => selectSubagent(s, item.id));
  // a task of this call is still live: a background agent answers at once ("launched") and goes on
  const live = useAppSelector((s) => selectLiveCalls(s).has(item.id));
  // a background agent's placeholder result says "launched"; how its task really ended is the task's word
  const ended = useAppSelector((s) => selectCallEnd(s, item.id));
  const type = str(item.input.subagent_type) || sub?.type || 'general-purpose';
  const description = str(item.input.description) || sub?.description || '';
  const status = item.result?.isError || (!live && ended === 'failed') ? 'error' : live ? 'running' : ended === 'stopped' ? 'stopped' : item.result ? 'done' : busy ? 'running' : 'stopped';
  const color = status === 'error' ? 'text-destructive' : status === 'running' ? 'text-nb-accent' : 'text-muted-foreground';
  return (
    <div
      data-kind="agent-card"
      data-status={status}
      className="my-2.5 flex items-center gap-2 rounded-md border border-border-soft bg-muted/30 py-1 pr-1.5 pl-2 font-mono text-[0.71875rem] leading-normal"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={onToggle}
        data-anchor-skip
        className="min-w-0 flex-1 cursor-pointer truncate rounded-sm text-left text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> <span data-agent-type className="text-foreground/80">{type}</span>
        {description ? <span data-agent-desc> · {description}</span> : ''}
        {!open && comments > 0 && <span className="text-nb-accent"> · {t('nComments', comments)}</span>}
      </button>
      <span data-anchor-skip data-agent-status className={color}>{t(status === 'running' ? 'agentRunning' : status === 'error' ? 'agentError' : status === 'stopped' ? 'agentStopped' : 'agentDone')}</span>
      <CardMenu call={item.id} />
      <button
        type="button"
        data-anchor-skip
        data-agent-open
        title={t('agentOpenTip')}
        onClick={() => dispatch(openAgent({ tool: item.id, title: description || type }))}
        className="flex-none cursor-pointer rounded border border-border-soft px-2 py-0.5 text-foreground hover:border-border hover:bg-muted"
      >
        {t('agentOpen')}
      </button>
    </div>
  );
}

/** The feed draws a subagent's call as this card (issue 511): it stands alone, in no run of actions. */
export const agentCall: ToolRenderer = { match: (it) => isAgentTool(it.name, it.toolKind), render: AgentCard };
