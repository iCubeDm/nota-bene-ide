import { useEffect, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { PanelResizer, usePanelWidth } from '@/shell/PanelResizer.tsx';
import { openChanges } from '@/tabs/slice.ts';
import { selectTree } from '@/tree/slice.ts';
import { StatusMark } from './DiffBody.tsx';
import { currentFile, focusFile, loadDiff, pickBase, setPanel, useVcsUi } from './store.ts';
import { useLiveDiff } from './useLiveDiff.ts';

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** The tool window next to Files: what changed, from where. Clicking a file jumps to it in the Changes tab. */
export function ChangesPanel() {
  const t = useT();
  const d = useAppDispatch();
  const { panel, focus } = useVcsUi();
  const treeOpen = useAppSelector(selectTree).open;
  const { root, src, base: picked, data } = useLiveDiff(panel);
  const repo = data?.repo ? data : null;
  const files = repo?.files ?? [];
  const size = usePanelWidth('panel:changes:width', 300, 200);
  const [filter, setFilter] = useState('');
  useEffect(() => { if (treeOpen) setPanel(false); }, [treeOpen]); // a reveal opened Files
  if (!panel) return null;
  const add = files.reduce((n, f) => n + (f.add ?? 0), 0), del = files.reduce((n, f) => n + (f.del ?? 0), 0);
  const cur = currentFile(files, focus?.path);
  const shown = files.filter((f) => f.path.toLowerCase().includes(filter.trim().toLowerCase()));
  const value = picked === 'BASE' || (picked && repo?.candidates.includes(picked)) ? picked : ''; // a stored branch may be gone
  const how = value === 'BASE' && repo?.how === 'reflog' ? t('vcsHowReflog') : value === 'BASE' && repo?.how === 'default' ? t('vcsHowDefault') : '';
  return (
    <aside id="changes-sheet" style={{ width: size.width, maxWidth: '45vw' }} className="relative flex flex-none flex-col border-r border-border-soft bg-chrome">
      <PanelResizer edge="right" width={size.width} onWidth={size.set} onReset={size.reset} min={200} label={t('vcsPanelWidth')} />
      <div className="flex h-9 flex-none items-center gap-2 px-3 text-[13px] font-semibold text-foreground">
        {t('vcsChanges')}
        <span className="flex-1" />
        <button type="button" title={t('vcsRefresh')} aria-label={t('vcsRefresh')} onClick={() => void loadDiff(root, src, picked)} className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted">↻</button>
      </div>
      {!repo ? data && <p className="p-3 text-xs text-muted-foreground">{t('vcsNoRepo')}</p> : (
        <>
          <label className="mx-2 flex flex-none flex-col gap-1 text-[11px] text-muted-foreground">
            <span>{t('vcsShow')}{how && ` · ${how}`}</span>
            <select aria-label={t('vcsCompare')} value={value} onChange={(e) => pickBase(root, src, e.target.value || null)} className="h-[30px] truncate rounded-lg border border-transparent bg-muted/50 px-2 text-[12.5px] text-foreground outline-0 focus:border-primary/50">
              <option value="">{repo.live ? t('vcsUncommitted') : repo.detected ? t('vcsWholeBranch', repo.detected) : t('vcsNoBase')}</option>
              {repo.live && repo.detected && <option value="BASE">{t('vcsWholeBranch', repo.detected)}</option>}
              {repo.candidates.map((b) => <option key={b} value={b}>{t('vcsWholeBranch', b)}</option>)}
            </select>
          </label>
          <div className="mx-3 mt-2 flex flex-none items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span>{t('vcsNofM', shown.length, files.length)}</span><span className="text-success">+{add}</span><span className="text-destructive">−{del}</span>
          </div>
          {!!repo.commits.length && (
            <details className="mx-2 mt-1.5 flex-none text-[12px] text-muted-foreground">
              <summary className="cursor-pointer rounded px-1 py-0.5 hover:bg-muted">{t('vcsCommitsN', repo.commits.length)}</summary>
              <ul className="nb-thin max-h-40 overflow-auto px-1 py-1">
                {repo.commits.map((c) => <li key={c.sha} className="truncate" title={c.subject}><span className="font-mono text-[11px] opacity-70">{c.sha}</span> {c.subject}</li>)}
              </ul>
            </details>
          )}
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('vcsFilterFiles')} aria-label={t('vcsFilterFiles')} className="mx-2 mt-2 mb-1 h-[30px] flex-none rounded-lg border border-transparent bg-muted/50 px-2.5 text-[12.5px] text-foreground outline-0 focus:border-primary/50" />
          <div className="nb-thin min-h-0 flex-1 overflow-auto px-1.5 pb-3">
            {shown.map((f) => (
              <button key={f.path} type="button" title={f.path} onClick={() => { d(openChanges()); focusFile(f.path); }} className={`flex h-[26px] w-full items-center gap-1.5 rounded px-1.5 text-left text-[12.5px] hover:bg-muted ${cur === f ? 'bg-primary/15' : ''}`}>
                <StatusMark s={f.status} />
                <span className="flex-none truncate text-foreground">{base(f.path)}</span>
                <span className="min-w-0 truncate text-[11px] text-muted-foreground">{dir(f.path)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
