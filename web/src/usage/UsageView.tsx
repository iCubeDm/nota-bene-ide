import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { USAGE_PERIODS, type UsageCallRow, type UsagePeriod, type UsageProvider, type UsageReport, type UsageTaskRow } from '@nota-bene/shared';
import { useAppSelector } from '@/store/store.ts';
import { getLang, useT } from '@/i18n/index.ts';
import { apiFetch } from '@/net/auth.ts';

const POLL_MS = 2000;
const AGENTS_SHOWN = 12;
const PROVIDERS: { id: UsageProvider; name: string }[] = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }];
const PERIOD_KEY = { trip: 'usagePeriodTrip', '7d': 'usagePeriod7d', '30d': 'usagePeriod30d', all: 'usagePeriodAll' } as const;
/** Model bars, by rank in the report: the theme's colours, the last for the rest. */
const BAR = ['bg-primary', 'bg-nb-accent', 'bg-foreground/60', 'bg-muted-foreground'];

const pct = (a: number, b: number): string => (b > 0 ? `${Math.round(a / b * 100)}%` : '0%');
const num = (n: number): string => n.toLocaleString(getLang());
/** Large counts in the unit that reads best. */
export function fmtTokens(n: number): string {
  const lang = getLang();
  const unit = (v: number, ru: string, en: string) => `${v.toFixed(1)}${lang === 'ru' ? ` ${ru}` : en}`;
  return n >= 1e9 ? unit(n / 1e9, 'млрд', 'B') : n >= 1e6 ? unit(n / 1e6, 'млн', 'M') : n >= 1e3 ? unit(n / 1e3, 'тыс', 'k') : String(Math.round(n));
}
const when = (ts: number): string => new Date(ts).toLocaleString(getLang(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const day = (ts: number): string => new Date(ts).toLocaleDateString(getLang(), { day: 'numeric', month: 'short' });
const modelName = (id: string): string => id.replace(/^claude-/, '');

const TH = 'border-b border-border px-2 py-1 text-left text-xs font-medium text-muted-foreground';
const TN = `${TH} text-right`;
const TD = 'border-b border-muted px-2 py-1.5 align-top [overflow-wrap:anywhere]';
const NUM = `${TD} text-right font-mono whitespace-nowrap`;

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {sub && <p className="mb-2 text-xs text-muted-foreground">{sub}</p>}
      {children}
    </section>
  );
}

function Kpi({ label, value, note, tip }: { label: string; value: string; note: string; tip?: string }) {
  return (
    <div className="rounded-md bg-card px-3 py-2" title={tip}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-mono text-xl font-medium">{value}</div>
      <div className="text-xs text-muted-foreground">{note}</div>
    </div>
  );
}

function Bar({ parts }: { parts: { key: string; value: number; color: string; title?: string }[] }) {
  const sum = parts.reduce((a, p) => a + p.value, 0);
  return (
    <div className="mt-1 flex h-1.5 overflow-hidden rounded-sm bg-muted">
      {parts.map((p) => <i key={p.key} title={p.title} className={`block h-full ${p.color}`} style={{ width: `${sum ? p.value / sum * 100 : 0}%` }} />)}
    </div>
  );
}

function Weeks({ weeks }: { weeks: UsageReport['weeks'] }) {
  const shown = weeks.slice(-12);
  const max = Math.max(1, ...shown.map((w) => w.w));
  return (
    <div className="flex h-32 items-end gap-1.5" role="img" aria-label="weeks">
      {shown.map((w) => (
        <div key={w.key} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${w.key}: ${fmtTokens(w.w)}`}>
          <span className="font-mono text-[10px] text-muted-foreground">{fmtTokens(w.w).replace(/\s.*/, '')}</span>
          <i className="block w-full rounded-sm bg-primary" style={{ height: `${w.w / max * 88}px` }} />
          <span className="font-mono text-[10px] text-muted-foreground">{w.key.slice(8)}.{w.key.slice(5, 7)}</span>
        </div>
      ))}
    </div>
  );
}

function CallRow({ c, agents, main }: { c: UsageCallRow; agents: Map<string, string>; main: string }) {
  return (
    <tr>
      <td className="py-0.5 pr-2 text-muted-foreground">{c.agent ? agents.get(c.agent) || c.agent : main}</td>
      <td className="py-0.5 pr-2 whitespace-nowrap">{modelName(c.model)}</td>
      <td className="py-0.5 pr-2 text-right font-mono">{fmtTokens(c.out)}</td>
      <td className="py-0.5 pr-2 text-right font-mono">{fmtTokens(c.read)}</td>
      <td className="py-0.5 text-right font-mono">{fmtTokens(c.w)}</td>
    </tr>
  );
}

function TaskDetail({ task, color }: { task: UsageTaskRow; color: (model: string) => string }) {
  const t = useT();
  const agents = new Map(task.agents.map((a) => [a.id, a.label]));
  return (
    <div className="grid gap-2 py-1 text-xs">
      {task.agents.length > 0 && (
        <table className="w-full">
          <thead><tr className="text-muted-foreground"><th className="text-left font-medium">{t('usageAgentCol')}</th><th className="text-left font-medium">{t('usageModel')}</th><th className="pl-3 text-right font-medium">{t('usageCalls')}</th><th className="pl-3 text-right font-medium">{t('usageWeighted')}</th></tr></thead>
          <tbody>
            {task.agents.slice(0, AGENTS_SHOWN).map((a) => (
              <tr key={a.id}>
                <td className="py-0.5 pr-2">{a.label || a.id}</td>
                <td className="py-0.5 pr-2 whitespace-nowrap"><i className={`mr-1.5 inline-block size-2 rounded-sm ${color(a.model)}`} />{modelName(a.model)}</td>
                <td className="py-0.5 pr-2 text-right font-mono whitespace-nowrap">{a.calls}</td>
                <td className="py-0.5 text-right font-mono whitespace-nowrap">{fmtTokens(a.w)}</td>
              </tr>
            ))}
            {task.agents.length > AGENTS_SHOWN && <tr><td colSpan={4} className="py-0.5 text-muted-foreground">{t('usageMoreAgents', task.agents.length - AGENTS_SHOWN)}</td></tr>}
          </tbody>
        </table>
      )}
      <table className="w-full">
        <thead><tr className="text-muted-foreground"><th className="text-left font-medium">{t('usageTopCalls')}</th><th className="text-left font-medium">{t('usageModel')}</th><th className="pl-3 text-right font-medium">{t('usageOutput')}</th><th className="pl-3 text-right font-medium">{t('usageCacheRead')}</th><th className="pl-3 text-right font-medium">{t('usageWeighted')}</th></tr></thead>
        <tbody>{task.top.map((c, i) => <CallRow key={i} c={c} agents={agents} main={t('usageMain')} />)}</tbody>
      </table>
    </div>
  );
}

function Report({ r }: { r: UsageReport }) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const rank = new Map(r.models.map((m, i) => [m.key, i]));
  const color = (model: string) => BAR[Math.min(rank.get(model) ?? BAR.length, BAR.length - 1)]!;
  const mix = (models: Record<string, number>) =>
    Object.entries(models).sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ key, value, color: color(key), title: modelName(key) }));
  const top = r.models[0];
  return (
    <>
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Kpi label={t('usageWeighted')} value={fmtTokens(r.total.w)} note={t('usageNCalls', num(r.total.calls))} tip={t('usageWeightedTip')} />
        <Kpi label={t('usageCacheRead')} value={fmtTokens(r.total.read)} note={t('usageOutputN', fmtTokens(r.total.out))} />
        <Kpi label={top ? modelName(top.key) : t('usageModel')} value={top ? pct(top.w, r.total.w) : '0%'} note={t('usageOfWeighted')} />
        <Kpi label={t('usageSubagents')} value={pct(r.total.sub, r.total.w)} note={fmtTokens(r.total.sub)} />
      </div>

      <Section title={t('usageHits')} sub={t('usageHitsSub')}>
        {r.hits.length === 0 ? <p className="text-[13px] text-muted-foreground">{t('usageHitsNone')}</p> : (
          <table className="w-full border-collapse text-[13px]">
            <thead><tr><th className={TH}>{t('usageWhen')}</th><th className={TH}>{t('usageLimit')}</th><th className={TN}>{t('usageCalls')}</th><th className={TN}>{t('usageWeighted')}</th><th className={TH}>{t('usageWentTo')}</th></tr></thead>
            <tbody>
              {r.hits.map((h) => (
                <tr key={`${h.kind}${h.ts}`}>
                  <td className={TD}>{when(h.ts)}</td>
                  <td className={`${TD} font-medium text-destructive`}>{h.kind === 'week' ? t('usageWeek') : t('usageH5')}</td>
                  <td className={NUM}>{num(h.calls)}</td>
                  <td className={NUM}>{fmtTokens(h.w)}</td>
                  <td className={TD}>
                    {Object.entries(h.projects).sort((a, b) => b[1] - a[1]).map(([p, w]) => `${p} ${pct(w, h.w)}`).join(', ')}
                    <Bar parts={mix(h.models)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title={t('usageModels')} sub={t('usageModelsSub')}>
        <table className="w-full border-collapse text-[13px]">
          <thead><tr><th className={TH}>{t('usageModel')}</th><th className={TN}>{t('usageCalls')}</th><th className={TN}>{t('usageOutput')}</th><th className={TN}>{t('usageCacheWrite')}</th><th className={TN}>{t('usageCacheRead')}</th><th className={TN}>{t('usageWeighted')}</th><th className={TN}>{t('usageShare')}</th></tr></thead>
          <tbody>
            {r.models.map((m) => (
              <tr key={m.key}>
                <td className={TD}>{modelName(m.key)}<Bar parts={[{ key: m.key, value: m.w, color: color(m.key) }, { key: '-', value: r.total.w - m.w, color: 'bg-transparent' }]} /></td>
                <td className={NUM}>{num(m.calls)}</td>
                <td className={NUM}>{fmtTokens(m.out)}</td>
                <td className={NUM}>{fmtTokens(m.write)}</td>
                <td className={NUM}>{fmtTokens(m.read)}</td>
                <td className={NUM}>{fmtTokens(m.w)}</td>
                <td className={NUM}>{pct(m.w, r.total.w)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={t('usageTasks')} sub={t('usageTasksSub')}>
        <table className="w-full border-collapse text-[13px]">
          <thead><tr><th className={TH}>{t('usageTask')}</th><th className={TH}>{t('usageProject')}</th><th className={TN}>{t('usageCalls')}</th><th className={TN}>{t('usageWeighted')}</th><th className={TN}>{t('usageSubagents')}</th></tr></thead>
          <tbody>
            {r.tasks.map((task) => (
              <Fragment key={task.id}>
                <tr>
                  <td className={TD}>
                    <button type="button" aria-expanded={open === task.id} onClick={() => setOpen(open === task.id ? null : task.id)} className="cursor-pointer text-left hover:text-primary">
                      {task.label || t('usageNoLabel')}
                    </button>
                    <div className="text-xs text-muted-foreground">{when(task.ts)}</div>
                    <Bar parts={mix(task.models)} />
                  </td>
                  <td className={TD}>{task.project}</td>
                  <td className={NUM}>{num(task.calls)}</td>
                  <td className={NUM}>{fmtTokens(task.w)}</td>
                  <td className={NUM}>{pct(task.sub, task.w)}</td>
                </tr>
                {open === task.id && <tr><td colSpan={5} className={TD}><TaskDetail task={task} color={color} /></td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Section>

      <div className="grid gap-5 md:grid-cols-2">
        <Section title={t('usageProjects')}>
          <table className="w-full border-collapse text-[13px]">
            <thead><tr><th className={TH}>{t('usageProject')}</th><th className={TN}>{t('usageWeighted')}</th><th className={TN}>{t('usageSubagents')}</th></tr></thead>
            <tbody>
              {r.projects.map((p) => (
                <tr key={p.key}>
                  <td className={TD}>{p.key}<Bar parts={[{ key: p.key, value: p.w, color: 'bg-primary' }, { key: '-', value: r.total.w - p.w, color: 'bg-transparent' }]} /></td>
                  <td className={NUM}>{fmtTokens(p.w)}</td>
                  <td className={NUM}>{pct(p.sub, p.w)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        <Section title={t('usageWeeks')}><Weeks weeks={r.weeks} /></Section>
      </div>

      <Section title={t('usageTank')} sub={t('usageTankSub')}>
        {r.tanks.length === 0 ? <p className="text-[13px] text-muted-foreground">{t('usageTankNone')}</p> : (
          <table className="w-full border-collapse text-[13px]">
            <thead><tr><th className={TH}>{t('usageWindow')}</th><th className={TN}>{t('usageGained')}</th><th className={TN}>{t('usageWeighted')}</th><th className={TN}>{t('usagePerPct')}</th></tr></thead>
            <tbody>
              {r.tanks.map((k) => (
                <tr key={k.from}>
                  <td className={TD}>{day(k.from)} – {day(k.to)}</td>
                  <td className={NUM}>{Math.round(k.pct)}%</td>
                  <td className={NUM}>{fmtTokens(k.w)}</td>
                  <td className={NUM}>{fmtTokens(k.perPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

const ACTION = 'cursor-pointer rounded-md border border-border bg-muted px-3 py-1 text-[13px]';
const SEG = 'cursor-pointer px-3 py-1 text-[13px] text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground';

/** The Usage tab: exact token accounting from the transcripts of every project (the design note is in docs/superpowers/specs). */
export function UsageView({ active }: { active: boolean }) {
  const t = useT();
  const windowProvider = useAppSelector((s) => s.controls.capabilities?.provider);
  const [choice, setChoice] = useState<UsageProvider | null>(null);
  const provider: UsageProvider = choice ?? (windowProvider === 'codex' ? 'codex' : 'claude');
  const [period, setPeriod] = useState<UsagePeriod>('trip');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const r = await apiFetch(`/usage?provider=${provider}&period=${period}`);
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as UsageReport;
        if (!live) return;
        setReport(data);
        setError(null);
        if (data.importing) timer = setTimeout(() => void load(), POLL_MS);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [provider, period, active, n]);

  const reset = async () => {
    setAsking(false);
    const r = await apiFetch('/usage/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider }) }).catch(() => null);
    if (r?.ok) { setPeriod('trip'); setN((x) => x + 1); } else setError(t('usageLoadFail', String(r?.status ?? 'network')));
  };

  const shown = report?.provider === provider && report.period === period ? report : null;
  return (
    <div className="mx-auto grid max-w-5xl gap-5 px-5 py-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          {PROVIDERS.map((p) => <button key={p.id} type="button" aria-pressed={provider === p.id} className={SEG} onClick={() => setChoice(p.id)}>{p.name}</button>)}
        </div>
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          {USAGE_PERIODS.map((p) => <button key={p} type="button" aria-pressed={period === p} className={SEG} onClick={() => setPeriod(p)}>{t(PERIOD_KEY[p])}</button>)}
        </div>
        <span className="min-w-40 flex-1 text-[13px] text-muted-foreground">
          {shown?.from ? t('usageSince', when(shown.from)) : shown?.period === 'trip' ? t('usageNeverReset') : ''}
        </span>
        <button type="button" onClick={() => setAsking(!asking)} aria-expanded={asking} className={ACTION}>{t('usageReset')}</button>
      </div>
      {asking && (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-card px-3 py-2 text-[13px]">
          <span className="flex-1">{t('usageResetQ')}</span>
          <button type="button" onClick={() => void reset()} className={ACTION}>{t('usageReset')}</button>
          <button type="button" onClick={() => setAsking(false)} className={ACTION}>{t('cancel')}</button>
        </div>
      )}
      {error && <p role="alert" className="text-[13px] text-destructive">{t('usageLoadFail', error)}</p>}
      {shown?.importing && <p role="status" className="text-[13px] text-warn">{t('usageImporting')}</p>}
      {!shown && !error && <p className="text-[13px] text-muted-foreground">{t('usageLoading')}</p>}
      {shown && (shown.total.calls === 0 && !shown.importing ? <p className="text-[13px] text-muted-foreground">{t('usageEmpty')}</p> : <Report r={shown} />)}
    </div>
  );
}
