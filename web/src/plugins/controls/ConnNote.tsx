import { useT, selectConn, useAppSelector, selectRestarting, selectSwitching } from '@/sdk';

/** The header's word on the connection: connecting, offline, or the agent's switch or restart under way. */
export function ConnNote() {
  const t = useT();
  const conn = useAppSelector(selectConn);
  const switching = useAppSelector(selectSwitching);
  const restarting = useAppSelector(selectRestarting);
  return <span id="conn" className="text-warn">{conn === 'connecting' ? t('connecting') : conn === 'closed' ? t('offline') : switching ? t(restarting ? 'restarting' : 'switching') : ''}</span>;
}
