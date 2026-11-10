import { useEffect, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import type { FeedItem } from '@/store/feed.ts';
import { answerPermission, useAppDispatch } from '@/store/store.ts';

export function PermissionCard({ item }: { item: Extract<FeedItem, { kind: 'permission' }> }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const [values, setValues] = useState<Record<string, string>>({});
  const prompt = item.prompt;
  // the picked options (indices) are state of their own, so an option label may hold a comma; `values` is the typed text
  const [picks, setPicks] = useState<Record<string, number[]>>({});
  useEffect(() => { if (item.answer !== undefined) { setValues({}); setPicks({}); } }, [item.answer]);
  type Field = NonNullable<NonNullable<typeof prompt>['fields']>[number];
  const valueOf = (f: Field) => [...(picks[f.id] ?? []).map((i) => f.options?.[i] ?? ''), ...(values[f.id]?.trim() ? [values[f.id].trim()] : [])].join(', ');
  const answers = () => Object.fromEntries((prompt?.fields ?? []).map((f) => [f.id, f.options?.length ? valueOf(f) : values[f.id] ?? '']));
  const choiceLabel = (label: string) => /^Approve .+ for this session$/.test(label) ? t('allowSession') : ({ accept: t('allow'), decline: t('deny'), cancel: t('cancel'), acceptForSession: t('allowSession'), 'Allow for this turn': t('allowTurn'), 'Allow for this session': t('allowSession'), 'Deny': t('deny'), 'Cancel': t('cancel'), 'Accept': t('allow'), 'Decline': t('deny'), 'Send answers': t('sendAnswers'), 'Approve': t('allow'), 'Allow once': t('allow'), 'Always allow': t('allowAlways'), 'Reject': t('deny'), 'Always reject': t('denyAlways') })[label] ?? label;
  const title = prompt?.title === 'Additional Codex permissions' ? t('codexPermissions') : prompt?.title === 'MCP request' ? t('nativeMcpRequest') : prompt?.title;
  const resolved = item.answer !== undefined;
  const body = String(item.input.command ?? item.input.file_path ?? JSON.stringify(item.input, null, 2));
  const btn = 'rounded-lg border border-transparent px-3 py-1 text-[0.8125rem] font-medium';
  return (
    <div
      data-kind="permission"
      className={
        'my-2.5 rounded-[10px] border bg-card px-3 py-2 text-[0.8125rem] ' +
        (resolved || item.archived ? 'border-border-soft opacity-60' : 'border-warn')
      }
    >
      <b>{title ?? t('allowQ', item.toolName)}</b>
      {Object.keys(item.input).length > 0 && <pre className="my-1.5 max-h-[200px] overflow-auto whitespace-pre-wrap font-mono text-xs">{body}</pre>}
      {resolved ? (
        <span>{t(item.answer ? prompt?.fields ? 'answerSent' : 'allowed' : 'denied')}</span>
      ) : item.archived ? (
        <span data-archived>{t('askArchived')}</span>
      ) : prompt ? (
        <form onSubmit={(e) => e.preventDefault()} className="space-y-2">
          {prompt.url && <a href={prompt.url} target="_blank" rel="noreferrer" className="underline">{prompt.url}</a>}
          {(prompt.fields ?? []).map((f) => {
            const chosen = picks[f.id] ?? [];
            const qid = `q-${item.id}-${f.id}`;
            const pick = (i: number) => {
              setPicks({ ...picks, [f.id]: f.multi ? (chosen.includes(i) ? chosen.filter((v) => v !== i) : [...chosen, i]) : chosen.length === 1 && chosen[0] === i ? [] : [i] });
              if (!f.multi) setValues({ ...values, [f.id]: '' });
            };
            return <div key={f.id} className="space-y-1">
              {f.header && <span className="inline-block rounded bg-muted px-1.5 text-xs font-medium">{f.header}</span>}
              <label className="block whitespace-pre-wrap">
                <span id={qid}>{f.label}</span>
                <input aria-label={f.label} type={f.secret ? 'password' : 'text'} autoComplete="off" value={values[f.id] ?? ''} onChange={(e) => { setValues({ ...values, [f.id]: e.target.value }); if (!f.multi && chosen.length) setPicks({ ...picks, [f.id]: [] }); }} className="mt-1 block w-full rounded border border-border-soft bg-transparent p-2" />
              </label>
              {f.options?.length ? <div role={f.multi ? 'group' : 'radiogroup'} aria-labelledby={qid} className="flex max-h-60 flex-col gap-1 overflow-auto">{f.options.map((o, i) => <button key={i} type="button" role={f.multi ? 'checkbox' : 'radio'} aria-checked={chosen.includes(i)} onClick={() => pick(i)} className={`rounded border px-2 py-1 text-left ${chosen.includes(i) ? 'border-primary bg-muted' : 'border-border-soft'}`}>
                <span className="font-medium">{o}</span>{f.notes?.[i] ? <span className="block text-xs text-muted-foreground">{f.notes[i]}</span> : null}
              </button>)}</div> : null}
            </div>;
          })}
          <div className="flex flex-wrap gap-2">{prompt.choices.map((c) => <button key={c.id} type="button" className={`${btn} bg-muted`} disabled={!['cancel', 'decline', 'deny'].includes(c.id) && prompt.fields?.some((f) => f.required && !(f.options?.length ? valueOf(f) : values[f.id] ?? '').trim())} onClick={() => dispatch(answerPermission(item.id, true, { choice: c.id, ...(prompt.fields ? { values: answers() } : {}) }))}>{choiceLabel(c.label)}</button>)}</div>
        </form>
      ) : (
        <>
          <button
            className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}
            onClick={() => dispatch(answerPermission(item.id, true))}
          >
            {t('allow')}
          </button>{' '}
          <button
            className={`${btn} bg-muted text-muted-foreground hover:text-foreground`}
            onClick={() => dispatch(answerPermission(item.id, false))}
          >
            {t('deny')}
          </button>
        </>
      )}
    </div>
  );
}
