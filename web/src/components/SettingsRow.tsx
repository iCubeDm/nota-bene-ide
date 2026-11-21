import type { ReactNode } from 'react';
import { useT } from '../i18n/index.ts';

/** A labelled row of a Settings section (issue 511): the label in a column of its own, the control beside it. */
export const SettingsRow = ({ label, children }: { label: ReactNode; children: ReactNode }) => (
  <div className="flex items-baseline gap-4 py-1.5 text-[0.8125rem]">
    <div className="w-56 flex-none text-muted-foreground">{label}</div>
    <div className="min-w-0 flex-1 break-words text-foreground">{children}</div>
  </div>
);

/** Why a Settings section could not read its data; nothing while it could. */
export function SettingsFail({ error }: { error: string | null }) {
  const t = useT();
  return error ? <div role="alert" className="text-xs text-warn">{t('setLoadFail', error)}</div> : null;
}
