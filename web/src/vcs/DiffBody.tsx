import hljs from 'highlight.js';
import { memo, useMemo, useState } from 'react';
import { useAppDispatch } from '@/store/store.ts';
import { openFile } from '@/tabs/slice.ts';
import { Svg } from '@/tabs/TabStrip.tsx';
import { useT } from '@/i18n/index.ts';
import type { VcsFile } from '@nota-bene/shared';
import type { Hunk, ParsedPatch, Row } from './parse.ts';

/** A list row with its parsed patch. */
export type DiffFile = VcsFile & ParsedPatch;

const num = 'w-11 flex-none select-none pr-2 text-right text-muted-foreground/60 before:content-[attr(data-n)]';
const tint = { '+': 'bg-success/15', '-': 'bg-destructive/15', ' ': '' };
const lang = (p: string) => { const e = /\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase(); return e && hljs.getLanguage(e) ? e : null; };
const paint = (s: string, l: string | null) => { try { return l ? hljs.highlight(s, { language: l, ignoreIllegals: true }).value : null; } catch { return null; } };

function Code({ s, l }: { s: string; l: string | null }) {
  const html = l && s.length < 2000 ? paint(s, l) : null;
  // the newline keeps lines apart in the text a comment anchors to; the numbers are pseudo-elements, so they are not in it
  return html !== null ? <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: `${html}\n` }} />
    : <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{`${s}\n`}</span>;
}

const Unified = ({ h, l }: { h: Hunk; l: string | null }) => h.rows.map((r, i) => (
  <div key={i} className={`flex ${tint[r.t]}`}>
    <span data-n={r.o ?? ''} className={num} />
    <span data-n={r.n ?? ''} className={num} />
    <span data-n={r.t === ' ' ? '' : r.t} className="w-4 flex-none select-none text-center text-muted-foreground before:content-[attr(data-n)]" />
    <Code s={r.s} l={l} />
  </div>
));

/** A run of removed lines next to the run of added lines that replaced it. */
function pairs(rows: Row[]): [Row | null, Row | null][] {
  const out: [Row | null, Row | null][] = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i]!.t === ' ') { out.push([rows[i]!, rows[i]!]); i++; continue; }
    const del: Row[] = [], add: Row[] = [];
    while (rows[i]?.t === '-') del.push(rows[i++]!);
    while (rows[i]?.t === '+') add.push(rows[i++]!);
    for (let k = 0; k < Math.max(del.length, add.length); k++) out.push([del[k] ?? null, add[k] ?? null]);
  }
  return out;
}

function Split({ h, l, side }: { h: Hunk; l: string | null; side: 'o' | 'n' }) {
  const cell = (r: Row | null, s: 'o' | 'n') => (
    <div data-side={s} className={`flex w-1/2 min-w-0 ${r && r.t !== ' ' ? tint[r.t] : r ? '' : 'bg-muted/30'} ${s !== side ? 'select-none' : ''}`}>
      <span data-n={(s === 'o' ? r?.o : r?.n) ?? ''} className={num} />
      {r ? <Code s={r.s} l={l} /> : <span className="flex-1" />}
    </div>
  );
  return pairs(h.rows).map(([a, b], i) => <div key={i} className="flex">{cell(a, 'o')}<div className="w-px flex-none bg-border-soft" />{cell(b, 'n')}</div>);
}

const STATUS = { A: ['A', 'text-success'], M: ['M', 'text-nb-accent'], D: ['D', 'text-destructive'], R: ['R', 'text-primary'] } as const;

export const StatusMark = ({ s }: { s: VcsFile['status'] }) => <span className={`w-3 flex-none text-center font-mono text-[0.6875rem] font-semibold ${STATUS[s][1]}`}>{STATUS[s][0]}</span>;

export const FileDiff = memo(function FileDiff({ f, split, src, gitRef, canOpen }: { f: DiffFile; split: boolean; src: string; gitRef: string | undefined; canOpen: boolean }) {
  const t = useT();
  const d = useAppDispatch();
  const [shut, setShut] = useState(false);
  const [side, setSide] = useState<'o' | 'n'>('n');
  const size = f.hunks.reduce((n, h) => n + h.rows.length, 0);
  const l = useMemo(() => (size > 1500 ? null : lang(f.path)), [f.path, size]); // per-line highlighting is what a long file pays for
  const [force, setForce] = useState(false);
  const big = size > 3000 && !force;
  return (
    <section data-diff-file={f.path} className="nb-card m-0! w-full">
      <header className="sticky top-0 z-[2] flex h-8 items-center gap-2 rounded-t-lg border-b border-border-soft bg-chrome px-2 text-xs">
        <button type="button" aria-label={t(shut ? 'vcsExpand' : 'vcsCollapse')} onClick={() => setShut(!shut)} className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted">{shut ? '▸' : '▾'}</button>
        <StatusMark s={f.status} />
        <span className="min-w-0 truncate font-mono text-[0.75rem] text-foreground" title={f.path}>{f.old ? `${f.old} → ${f.path}` : f.path}</span>
        <span className="flex-none font-mono text-[0.6875rem] text-success">+{f.add ?? 0}</span>
        <span className="flex-none font-mono text-[0.6875rem] text-destructive">−{f.del ?? 0}</span>
        <span className="flex-1" />
        {canOpen && f.status !== 'D' && (
          <button type="button" title={t('vcsOpenFile')} aria-label={t('vcsOpenFile')} onClick={() => d(openFile({ path: f.path, src, ...(gitRef ? { ref: gitRef } : {}) }))} className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
            <Svg size={12}><path d="M7 17 17 7M9 7h8v8" /></Svg>
          </button>
        )}
      </header>
      {!shut && (f.binary ? <p className="p-3 text-xs text-muted-foreground">{t('binary')}</p>
        : big ? <p className="p-3 text-xs text-muted-foreground">{t('vcsBigDiff', size)} <button type="button" className="text-primary underline" onClick={() => setForce(true)}>{t('vcsShowAnyway')}</button></p>
        : !f.hunks.length ? <p className="p-3 text-xs text-muted-foreground">{t(f.status === 'A' ? 'vcsEmptyFile' : 'vcsOnlyMeta')}</p>
        : (
          <div data-file-path={f.path} onMouseDown={(e) => { const s = (e.target as Element).closest<HTMLElement>('[data-side]')?.dataset.side; if (s === 'o' || s === 'n') setSide(s); }} className="nb-code py-1 font-mono text-xs leading-[1.55]">
            {f.hunks.map((h, i) => (
              <div key={i}>
                <div data-n={h.head} className="select-none overflow-hidden bg-primary/10 px-3 py-0.5 text-[0.6875rem] whitespace-nowrap text-muted-foreground before:content-[attr(data-n)]" />
                {split ? <Split h={h} l={l} side={side} /> : <Unified h={h} l={l} />}
              </div>
            ))}
          </div>
        ))}
    </section>
  );
});
