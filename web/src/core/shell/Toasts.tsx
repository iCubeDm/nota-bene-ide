import { useStored } from '../sdk/storage.ts';
import { useT } from '@/core/i18n/index.ts';
import { dismissToast, getToasts, pauseToast, resumeToast, subscribeToasts } from './toast.ts';

/**
 * Top-right under the header (prototype: top 56px, right 16px, 380px). The live region stays mounted so additions are announced.
 * An error is red with its message as is; an offer (actions) is plain, its first action the primary one.
 */
export function Toasts() {
  const t = useT();
  const list = useStored({ subscribe: subscribeToasts, get: getToasts });
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed top-14 right-4 z-[20] flex w-[380px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {list.map((x) => (
        <div
          key={x.id}
          data-testid="toast"
          onMouseEnter={() => pauseToast(x.id)}
          onMouseLeave={() => { if (!x.actions) resumeToast(x.id); }}
          className={`pointer-events-auto rounded-xl border bg-card p-3 text-xs text-foreground shadow-[0_8px_30px_color-mix(in_oklch,var(--shade)_40%,transparent)] ${x.actions ? 'border-border' : 'border-destructive/40'}`}
        >
          <div className="flex items-start gap-2">
            <b className={`min-w-0 flex-1 ${x.actions ? '' : 'text-destructive'}`}>{x.title}{x.count > 1 ? ` ×${x.count}` : ''}</b>
            <button
              type="button"
              aria-label={t('close')}
              onClick={() => dismissToast(x.id)}
              className="-mt-0.5 grid size-5 flex-none cursor-pointer place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              ✕
            </button>
          </div>
          {x.actions ? (
            <>
              <p className="mt-1 text-muted-foreground">{x.msg}</p>
              <div className="mt-2.5 flex justify-end gap-1">
                {x.actions.map((a, i) => (
                  <button
                    key={a.label}
                    type="button"
                    onClick={() => { dismissToast(x.id); a.run(); }}
                    className={i === 0 ? 'rounded bg-primary px-2 py-1 text-primary-foreground hover:opacity-90' : 'rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground'}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <pre className="mt-1.5 max-h-40 overflow-auto font-mono text-[0.6875rem] whitespace-pre-wrap">{x.msg}</pre>
          )}
        </div>
      ))}
    </div>
  );
}
