// Issue 661: one window, one agent. The chat's tab carries ✕, which closes this page's agent after a confirm (issue 636);
// the page then goes to the server's home (issue 639). Another computer's page has none.
import { useState } from 'react';
import { remotePage, toast, useChatTab, useT } from '@/sdk';
import { ConfirmDialog, Svg } from '@/sdk/ui';
import { nav, PROVIDER_LABEL, reasonText, stopProject, useProjects, type RunningRow } from './api.ts';

export function AgentClose() {
  const t = useT();
  const { data } = useProjects(false);
  const [closing, setClosing] = useState(false);
  const chat = useChatTab();
  const remote = remotePage();
  const here = data?.running.find((r) => r.current);
  if (!here?.agent || remote) return <>{chat()}</>;
  const close = async () => {
    setClosing(false);
    const why = await stopProject(here);
    if (why) return toast(t('agentClose'), reasonText(why));
    nav.go('/');
  };
  return (
    <>
      {chat(<CloseX r={here} onClose={() => setClosing(true)} />)}
      {closing && (
        <ConfirmDialog title={t('agentCloseQ')} body={t('agentCloseBody', agentName(here))} confirm={t('agentClose')} danger
          onConfirm={() => void close()} onCancel={() => setClosing(false)} />
      )}
    </>
  );
}

const agentName = (r: RunningRow) => [PROVIDER_LABEL[r.provider], r.title].filter(Boolean).join(' · ');

/** ✕ of the chat's tab: Enter and Space on it do not reach the tab. */
function CloseX({ r, onClose }: { r: RunningRow; onClose: () => void }) {
  const t = useT();
  return (
    <button type="button" aria-label={`${t('agentClose')}: ${agentName(r)}`} title={t('agentClose')}
      onClick={(e) => { e.stopPropagation(); onClose(); }} onKeyDown={(e) => e.stopPropagation()}
      className="grid size-[18px] flex-none place-items-center rounded-[5px] text-muted-foreground opacity-50 hover:bg-muted hover:opacity-100">
      <Svg size={10}><path d="M18 6 6 18M6 6l12 12" /></Svg>
    </button>
  );
}
