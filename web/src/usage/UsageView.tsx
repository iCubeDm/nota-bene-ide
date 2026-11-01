import { Fragment, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { USAGE_PERIODS, type UsageHit, type UsagePeriod, type UsageProvider, type UsageReport, type UsageTaskRow } from '@nota-bene/shared';
import { useAppSelector } from '@/store/store.ts';
import { getLang, useT } from '@/i18n/index.ts';
import { apiFetch } from '@/net/auth.ts';

const POLL_MS = 2000;
const AGENTS_SHOWN = 12, MODELS_SHOWN = 2, ROWS_SHOWN = 5, WEEKS_SHOWN = 16, WINDOWS_SHOWN = 32, TANKS_SHOWN = 4;
const PROVIDERS: { id: UsageProvider; name: string }[] = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }];
const PERIOD_KEY = { trip: 'usagePeriodTrip', '7d': 'usagePeriod7d', '30d': 'usagePeriod30d', all: 'usagePeriodAll' } as const;
/** The named models, by rank in the report; everything else is the rest. */
const MODEL_COLOR = ['bg-primary', 'bg-nb-accent'];
const REST_COLOR = 'bg-muted-foreground';

const pct = (a: number, b: number): string => (b > 0 ? `${Math.round(a / b * 100)}%` : '0%');
const num = (n: number): string => n.toLocaleString(getLang());
/** Large counts in the unit that reads best. */
export function fmtTokens(n: number): string {
  const lang = getLang();
  const unit = (v: number, ru: string, en: string) => `${v.toFixed(1)}${lang === 'ru' ? ` ${ru}` : en}`;
  return n >= 1e9 ? unit(n / 1e9, 'млрд', 'B') : n >= 1e6 ? unit(n / 1e6, 'млн', 'M') : n >= 1e3 ? unit(n / 1e3, 'тыс', 'k') : String(Math.round(n));
}
/** Minor units to the currency's own format; the currency says how many digits a minor unit is. */
function money(minor: number, currency: string | null): string {
  const f = new Intl.NumberFormat(getLang(), { style: 'currency', currency: currency ?? 'USD' });
  return f.format(minor / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2));
}

const when = (ts: number): string => new Date(ts).toLocaleString(getLang(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const shortTime = (ts: number): string => new Date(ts).toLocaleDateString(getLang(), { day: 'numeric', month: 'short' });
/** A week's Monday, `plus` days on. */
const weekDay = (key: string, plus = 0): string => {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() + plus);
  return shortTime(d.getTime());
};
/** claude-opus-5-5 reads Opus 5.5; anything else as it is. */
const modelName = (id: string): string =>
  id.replace(/^claude-/, '').replace(/^([a-z])([a-z]*)-(\d+)-(\d+)$/, (_, a: string, b: string, major: string, minor: string) => `${a.toUpperCase()}${b} ${major}.${minor}`);

const CHOICE = 'cursor-pointer text-muted-foreground hover:text-foreground aria-pressed:text-foreground aria-pressed:shadow-[0_1px_0_currentColor]';
const ACTION = 'cursor-pointer rounded-md border border-border-soft px-3 py-1 text-[13px] text-muted-foreground hover:text-foreground';
const LINE = 'flex justify-between gap-4';
const ELLIPSIS = 'min-w-0 truncate';
const VALUE = 'font-mono text-[13px] whitespace-nowrap';
const TH = 'border-b border-border px-2 py-1 text-left text-xs font-medium text-muted-foreground first:pl-0';
const TD = 'border-b border-border-soft px-2 py-1.5 align-top first:pl-0';

/** The trip meter: whole digits on dark wheels, the tenth on a lit one. */
function Odometer({ value }: { value: number }) {
  const [, whole = '', tenth, unit = ''] = /^(\d+)(?:\.(\d))?\s*(.*)$/.exec(fmtTokens(value)) ?? [];
  const WHEEL = 'block min-w-[0.82em] rounded-[3px] px-[0.06em] py-[0.2em] text-center';
  return (
    <>
      <span role="img" aria-label={fmtTokens(value)} className="inline-flex gap-0.5 font-mono text-[34px] leading-none font-medium tabular-nums">
        {[...whole].map((c, i) => <span key={i} className={`${WHEEL} bg-card`}>{c}</span>)}
        {tenth && <><span className="block py-[0.2em]">.</span><span className={`${WHEEL} bg-primary text-primary-foreground`}>{tenth}</span></>}
      </span>
      {unit && <span className="text-muted-foreground">{unit}</span>}
    </>
  );
}

/** A share of the whole, one mark per part, with a gap between them. */
function Mix({ parts, className = 'h-1.5' }: { parts: { key: string; value: number; color: string }[]; className?: string }) {
  return (
    <div className={`flex gap-0.5 overflow-hidden rounded-sm ${className}`}>
      {parts.map((p) => <i key={p.key} className={`block min-w-0.5 ${p.color}`} style={{ flex: p.value }} />)}
    </div>
  );
}

function ModelMix({ r }: { r: UsageReport }) {
  const t = useT();
  const shown = r.models.slice(0, MODELS_SHOWN);
  const rest = r.models.slice(MODELS_SHOWN);
  const restW = rest.reduce((a, m) => a + m.w, 0);
  const parts = [
    ...shown.map((m, i) => ({ key: m.key, value: m.w, color: MODEL_COLOR[i]!, name: modelName(m.key), tip: t('usageModelTip', num(m.calls), fmtTokens(m.out), fmtTokens(m.write), fmtTokens(m.read)) })),
    ...(rest.length ? [{ key: '-', value: restW, color: REST_COLOR, name: t('usageRest'), tip: rest.map((m) => modelName(m.key)).join(', ') }] : []),
  ];
  return (
    <div className="mt-4">
      <Mix parts={parts} className="h-2" />
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
        {parts.map((p) => (
          <span key={p.key} title={p.tip}>
            <i className={`mr-1.5 inline-block size-2 rounded-sm ${p.color}`} />
            <span className="font-medium">{p.name}</span> {p.value / r.total.w < 0.01 ? '<1%' : pct(p.value, r.total.w)} <span className="font-mono text-xs text-muted-foreground">{fmtTokens(p.value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

type BarItem = { key: string; w: number; hit: boolean; extra?: number; label: string };

/** One line of a bar's tip. `color`: the bar's own, for the parts the chart paints. */
function TipRow({ name, value, color }: { name: string; value?: string; color?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span>{color && <i className={`mr-1.5 inline-block size-2 rounded-sm ${color}`} />}{name}</span>
      {value && <span className="font-mono">{value}</span>}
    </div>
  );
}

/** Bars with a tip under the pointer. The whole column answers, so a low bar is as easy to reach as a tall one. */
function Bars({ title, bars, first, last }: { title: string; bars: BarItem[]; first: string; last: string }) {
  const t = useT();
  const [at, setAt] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map((b) => b.w));
  const tip = at === null ? undefined : bars[at];
  const side = at !== null && at < bars.length / 2 ? { left: `${at / bars.length * 100}%` } : { right: `${(bars.length - (at ?? 0) - 1) / bars.length * 100}%` };
  return (
    <figure className="m-0 min-w-0">
      <figcaption className="mb-1 text-xs text-muted-foreground">{title}</figcaption>
      <div className="relative" onMouseLeave={() => setAt(null)}>
        {tip && (
          <div role="status" className="pointer-events-none absolute bottom-full z-10 mb-1 rounded border border-border bg-card px-2 py-1 text-xs whitespace-nowrap" style={side}>
            <div className="mb-0.5 text-muted-foreground">{tip.label}</div>
            <TipRow name={t('usageBarTotal')} value={fmtTokens(tip.w)} />
            {tip.extra && tip.w > tip.extra ? <TipRow name={t('usageBarLimit')} value={fmtTokens(tip.w - tip.extra)} /> : null}
            {tip.extra ? <TipRow name="extra usage" value={fmtTokens(tip.extra)} color="bg-warn" /> : null}
            {tip.hit && <TipRow name={t('usageHitShort')} color="bg-destructive" />}
          </div>
        )}
        <div className="flex h-14 gap-[3px]" role="img" aria-label={title}>
          {bars.map((b, i) => (
            <div key={b.key} data-bar onMouseEnter={() => setAt(i)} className="flex h-full min-w-0 flex-1 flex-col justify-end">
              {b.extra ? <i data-extra className="block min-h-0.5 w-full rounded-t-sm bg-warn" style={{ height: `${b.extra / max * 100}%` }} /> : null}
              {b.w > (b.extra ?? 0) && <i className={`block min-h-0.5 w-full ${b.extra ? '' : 'rounded-t-sm'} ${b.hit ? 'bg-destructive' : at === i ? 'bg-muted-foreground' : 'bg-muted'}`} style={{ height: `${(b.w - (b.extra ?? 0)) / max * 100}%` }} />}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1 flex justify-between font-mono text-[11px] text-muted-foreground"><span>{first}</span><span>{last}</span></div>
    </figure>
  );
}

function HitRow({ h, currency }: { h: UsageHit; currency: string | null }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const went = Object.entries(h.projects).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([p, w]) => `${p} ${pct(w, h.w)}`).join(', ');
  return (
    <>
      <tr className="group cursor-pointer" onClick={() => setOpen(!open)}>
        <td className={TD}><button type="button" aria-expanded={open} className="cursor-pointer text-left whitespace-nowrap group-hover:text-primary">{when(h.ts)}</button></td>
        <td className={`${TD} whitespace-nowrap`}>{h.kind === 'week' ? t('usageWeek') : t('usageH5')}</td>
        <td className={`${TD} text-right font-mono whitespace-nowrap`}>{fmtTokens(h.w)}</td>
        <td className={`${TD} text-right font-mono whitespace-nowrap`}>{num(h.calls)}</td>
        <td className={`${TD} whitespace-nowrap text-muted-foreground`}>{went}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="max-w-0 border-b border-border-soft pb-2 pl-3.5 text-muted-foreground">
            {h.extra && <div className="pb-1">{t('usageHitExtra', fmtTokens(h.extra.w), h.extra.spent === null ? t('usageSumUnknown') : money(h.extra.spent, currency))}</div>}
            {h.tasks.map((k) => <div key={k.id} className={LINE}><span className={ELLIPSIS}>{k.label || t('usageNoLabel')}</span><span className={VALUE}>{fmtTokens(k.w)}</span></div>)}
          </td>
        </tr>
      )}
    </>
  );
}

function Limits({ r }: { r: UsageReport }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const windows = r.windows.slice(-WINDOWS_SHOWN);
  const weeks = r.weeks.slice(-WEEKS_SHOWN);
  const hits = r.hits.toReversed();
  if (windows.length === 0 && hits.length === 0 && r.tanks.length === 0 && !r.extra) return null;
  const extra = r.extra;
  return (
    <section className="grid min-w-0 gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold text-foreground">{t('usageHits')}</h2>
        {(windows.some((w) => w.hit) || weeks.some((w) => w.hit)) && <span className="text-xs text-muted-foreground">{t('usageHitMark')}{[...windows, ...weeks].some((b) => b.extra) ? `, ${t('usageExtraMark')}` : ''}</span>}
      </div>
      {windows.length > 0 && (
        <Bars
          title={t('usageByWindow')} first={shortTime(windows[0]!.from)} last={shortTime(windows.at(-1)!.from)}
          bars={windows.map((w) => ({ key: String(w.from), w: w.w, hit: w.hit, ...(w.extra ? { extra: w.extra } : {}), label: when(w.from) }))}
        />
      )}
      {weeks.length > 1 && (
        <Bars
          title={t('usageByWeek')} first={weekDay(weeks[0]!.key)} last={weekDay(weeks.at(-1)!.key)}
          bars={weeks.map((w) => ({ key: w.key, w: w.w, hit: w.hit, ...(w.extra ? { extra: w.extra } : {}), label: `${weekDay(w.key)} – ${weekDay(w.key, 6)}` }))}
        />
      )}
      {hits.length > 0 && (
        <div className="min-w-0">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH}>{t('usageWhen')}</th><th className={TH}>{t('usageLimit')}</th><th className={`${TH} text-right`}>{t('usageTokensCol')}</th>
                  <th className={`${TH} text-right`}>{t('usageCalls')}</th><th className={TH}>{t('usageProjects')}</th>
                </tr>
              </thead>
              <tbody>{hits.slice(0, all ? Infinity : ROWS_SHOWN).map((h) => <HitRow key={`${h.kind}${h.ts}`} h={h} currency={r.extra?.currency ?? null} />)}</tbody>
            </table>
          </div>
          {hits.length > ROWS_SHOWN && <button type="button" onClick={() => setAll(!all)} className={`${CHOICE} mt-1.5 text-[13px]`}>{all ? t('usageShowTop') : t('usageShowAll', hits.length)}</button>}
        </div>
      )}
      {extra && (
        <p className="text-[13px] text-muted-foreground" title={t('usageExtraTip')}>
          {t('usageExtra', fmtTokens(extra.w), extra.spent === null ? t('usageSumUnknown') : money(extra.spent, extra.currency))}
          {extra.month !== null && ` ${extra.limit === null ? t('usageExtraMonth', money(extra.month, extra.currency)) : t('usageExtraOf', money(extra.month, extra.currency), money(extra.limit, extra.currency))}`}
        </p>
      )}
      {r.tanks.length > 0 && (
        <p className="text-[13px] text-muted-foreground" title={t('usageTankTip')}>
          {t('usageTank')} <span className="font-mono text-foreground">{r.tanks.slice(-TANKS_SHOWN).map((k) => fmtTokens(k.perPct)).join(' → ')}</span>
        </p>
      )}
    </section>
  );
}

function TaskDetail({ task, color }: { task: UsageTaskRow; color: (model: string) => string }) {
  const t = useT();
  const agents = new Map(task.agents.map((a) => [a.id, a.label]));
  const parts = Object.entries(task.models).sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ key, value, color: color(key) }));
  return (
    <div className="grid gap-2 px-2 pt-1 pb-3 pl-4 text-[13px] text-muted-foreground">
      <div>
        <div className="mb-1">{t('usageTaskLine', num(task.calls), pct(task.sub, task.w), when(task.ts))}</div>
        <Mix parts={parts} />
      </div>
      {task.agents.length > 0 && (
        <div>
          <div className="text-foreground">{t('usageSubagents')}</div>
          {task.agents.slice(0, AGENTS_SHOWN).map((a) => <div key={a.id} className={LINE}><span className={ELLIPSIS}>{a.label || a.id}</span><span className={VALUE}>{modelName(a.model)} {a.calls} {fmtTokens(a.w)}</span></div>)}
          {task.agents.length > AGENTS_SHOWN && <div>{t('usageMoreAgents', task.agents.length - AGENTS_SHOWN)}</div>}
        </div>
      )}
      <div>
        <div className="text-foreground">{t('usageTopCalls')}</div>
        {task.top.map((c, i) => <div key={i} className={LINE}><span className={ELLIPSIS}>{c.agent ? agents.get(c.agent) || c.agent : t('usageMain')}, {modelName(c.model)}, {t('usageCallLine', fmtTokens(c.out), fmtTokens(c.read))}</span><span className={VALUE}>{fmtTokens(c.w)}</span></div>)}
      </div>
    </div>
  );
}

/** A row over a bar of its share of the longest one. */
function Row({ share, children, ...button }: { share: number; children: ReactNode } & ComponentProps<'button'>) {
  const body = (
    <>
      <i aria-hidden className="absolute inset-y-0 left-0 -z-10 rounded bg-card" style={{ width: `${share * 100}%` }} />
      {children}
    </>
  );
  const ROW = 'relative isolate my-px flex w-full items-baseline gap-4 rounded px-2 py-1.5 text-left text-[13px]';
  return button.onClick ? <button type="button" className={`group ${ROW} cursor-pointer`} {...button}>{body}</button> : <div className={ROW}>{body}</div>;
}

function Spent({ r, color }: { r: UsageReport; color: (model: string) => string }) {
  const t = useT();
  const [list, setList] = useState<'tasks' | 'projects'>('tasks');
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const items = list === 'tasks' ? r.tasks.length : r.projects.length;
  const shown = all ? Infinity : ROWS_SHOWN;
  const pick = (l: typeof list) => { setList(l); setAll(false); };
  return (
    <section className="min-w-0">
      <div className="mb-1.5 flex items-baseline gap-3.5">
        <h2 className="text-sm font-semibold text-foreground">{t('usageSpent')}</h2>
        <button type="button" aria-pressed={list === 'tasks'} onClick={() => pick('tasks')} className={`${CHOICE} text-[13px]`}>{t('usageTasks')}</button>
        <button type="button" aria-pressed={list === 'projects'} onClick={() => pick('projects')} className={`${CHOICE} text-[13px]`}>{t('usageProjects')}</button>
      </div>
      {list === 'tasks' ? r.tasks.slice(0, shown).map((task) => (
        <Fragment key={task.id}>
          <Row share={task.w / r.tasks[0]!.w} aria-expanded={open === task.id} onClick={() => setOpen(open === task.id ? null : task.id)}>
            <span className={`${ELLIPSIS} flex-1 group-hover:text-primary`}>{task.label || t('usageNoLabel')}</span>
            <span className="text-xs whitespace-nowrap text-muted-foreground">{task.project}</span>
            <span className={VALUE}>{fmtTokens(task.w)}</span>
          </Row>
          {open === task.id && <TaskDetail task={task} color={color} />}
        </Fragment>
      )) : r.projects.slice(0, shown).map((p) => (
        <Row key={p.key} share={p.w / r.projects[0]!.w}>
          <span className={`${ELLIPSIS} flex-1`}>{p.key}</span>
          <span className="text-xs whitespace-nowrap text-muted-foreground" title={t('usageSubagents')}>{p.sub > 0 ? pct(p.sub, p.w) : ''}</span>
          <span className={VALUE}>{fmtTokens(p.w)}</span>
        </Row>
      ))}
      {items > ROWS_SHOWN && <button type="button" onClick={() => setAll(!all)} className={`${CHOICE} mt-1.5 text-[13px]`}>{all ? t('usageShowTop') : t('usageShowAll', items)}</button>}
    </section>
  );
}

function Report({ r }: { r: UsageReport }) {
  const t = useT();
  const rank = new Map(r.models.map((m, i) => [m.key, i]));
  const color = (model: string) => MODEL_COLOR[rank.get(model) ?? MODEL_COLOR.length] ?? REST_COLOR;
  return (
    <>
      <div className="min-w-0">
        <ModelMix r={r} />
        <p className="mt-1 text-[13px] text-muted-foreground">{t('usageSide', num(r.total.calls), pct(r.total.sub, r.total.w))}</p>
      </div>
      <Limits r={r} />
      <Spent r={r} color={color} />
    </>
  );
}

const live = (r: UsageReport): boolean => r.total.calls > 0 || r.importing;

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
    <div className="mx-auto grid max-w-3xl gap-6 px-5 py-5">
      <div className="grid gap-5">
        <div className="flex flex-wrap items-baseline gap-5 text-[13px]">
          <div className="flex gap-3">
            {PROVIDERS.map((p) => <button key={p.id} type="button" aria-pressed={provider === p.id} className={CHOICE} onClick={() => setChoice(p.id)}>{p.name}</button>)}
          </div>
          <div className="flex gap-3">
            {USAGE_PERIODS.map((p) => <button key={p} type="button" aria-pressed={period === p} className={CHOICE} onClick={() => setPeriod(p)}>{t(PERIOD_KEY[p])}</button>)}
          </div>
        </div>
        {shown && live(shown) && (
          <div className="flex flex-wrap items-center gap-3.5">
            <Odometer value={shown.total.w} />
            <span className="text-muted-foreground underline decoration-dotted underline-offset-3" title={t('usageTotalsTip', fmtTokens(shown.total.read), fmtTokens(shown.total.out))}>{t('usageTokens')}</span>
            {shown.from && shown.period === 'trip' && <span className="text-[13px] text-muted-foreground">{t('usageSince', when(shown.from))}</span>}
            <button type="button" onClick={() => setAsking(!asking)} aria-expanded={asking} className={`${ACTION} ml-auto`}>{t('usageReset')}</button>
          </div>
        )}
        {shown && !live(shown) && <div className="flex"><button type="button" onClick={() => setAsking(!asking)} aria-expanded={asking} className={`${ACTION} ml-auto`}>{t('usageReset')}</button></div>}
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
      {shown && (live(shown) ? <Report r={shown} /> : <p className="text-[13px] text-muted-foreground">{t('usageEmpty')}</p>)}
    </div>
  );
}
