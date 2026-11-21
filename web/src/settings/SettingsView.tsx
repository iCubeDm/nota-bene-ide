import { useMemo, useState, type FC, type ReactNode } from 'react';
import { SettingsContext, useRegistry, useT, t as tNow, type Route, type SettingsHost, type TabView, send } from '@/sdk';
import { ConfirmDialog, ViewPane } from '@/sdk/ui';

type Ask = Parameters<SettingsHost['ask']>[0];

function Section({ title, children, aside, id }: { title: string; children: ReactNode; aside?: ReactNode; id: string }) {
  return (
    <section id={id} className="nb-card nb-prose px-6 py-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex-1 text-[0.9375rem] font-semibold text-foreground">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const Part = ({ part: P, active }: { part: FC<{ active: boolean }> | undefined; active: boolean }) => (P ? <P active={active} /> : null);

/**
 * The Settings tab (M6-15, R-M6-4): everything outside a session, in the sections the plugins register (issue 511):
 * Windows, Storage, Dictation, Defaults, Themes, About. The host gives them one POST, one status line and one confirm.
 */
export function SettingsView({ active }: { active: boolean }) {
  const t = useT();
  const { settings } = useRegistry();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const host = useMemo<SettingsHost>(() => ({
    post: async (route: Route, body: unknown = {}) => {
      try {
        const r = await send(route, body);
        if (r.ok) return r;
        setNote(tNow('setLoadFail', `${r.status}`));
      } catch (e) {
        setNote(tNow('setLoadFail', e instanceof Error ? e.message : String(e)));
      }
      return null;
    },
    note: setNote,
    ask: setAsk,
  }), []);

  return (
    <SettingsContext.Provider value={host}>
      <div className="pb-8">
        {note && <div role="status" className="nb-prose mx-auto mt-4 rounded-lg border border-border-soft bg-card px-4 py-2 text-xs text-foreground">{note}</div>}
        {settings.filter((s) => !s.in).map((s) => (
          <Section key={s.id} id={`settings-${s.id}`} title={s.title ? t(s.title) : ''} aside={<Part part={s.aside} active={active} />}>
            <Part part={s.render} active={active} />
            {settings.filter((r) => r.in === s.id).map((r) => <Part key={r.id} part={r.render} active={active} />)}
          </Section>
        ))}
        {ask && (
          <ConfirmDialog title={ask.title} body={ask.body} confirm={ask.confirm}
            onCancel={() => setAsk(null)} onConfirm={() => { const run = ask.run; setAsk(null); void run(); }} />
        )}
      </div>
    </SettingsContext.Provider>
  );
}

/** The Settings tab: one per window; it stays mounted across a root change. */
export const settingsTab: TabView<'settings'> = {
  kind: 'settings',
  label: (_tab, t) => t('settings'),
  render: ({ active }) => <ViewPane kind="settings" active={active}><SettingsView active={active} /></ViewPane>,
};
