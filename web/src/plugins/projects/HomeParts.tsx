// The server's home page's parts in the app's frame (issue 651): the header's title with the counts, the left strip's
// Projects button and its panel (the switcher's list as a tree: each project open on its agents and sessions), and the
// footer's counts of the agents by state.
import { useEffect } from 'react';
import { useAppDispatch, useAppSelector, useT } from '@/sdk';
import { ICONS, PanelResizer, Svg, ToolButton, usePanelWidth } from '@/sdk/ui';
import { selectProjectsPanel, setProjectsPanel, useProjects } from './api.ts';
import { ProjectsList } from './ProjectSwitcher.tsx';
import { badgeOf, foldRows, titlePrefix } from './rows.ts';
import { LIVE } from './Tile.tsx';

const PANEL_MIN = 220;
const done = () => {};

export function HomeTitle() {
  const t = useT();
  const { data } = useProjects(true);
  const running = data?.running ?? [];
  const badge = badgeOf(running);
  useEffect(() => { document.title = `${titlePrefix(badge)}Nota Bene`; }, [badge]);
  const agents = running.filter((r) => LIVE.has(r.state)).length;
  return (
    <div className="flex flex-col">
      <span className="px-1 text-[0.9375rem] font-semibold tracking-[-0.01em] text-foreground">Nota Bene</span>
      {data && <span className="px-1 font-mono text-[0.625rem] leading-3 opacity-70">{t('homeCounts', foldRows(running).length, agents)}</span>}
    </div>
  );
}

export function ProjectsToggle() {
  const t = useT();
  const d = useAppDispatch();
  const open = useAppSelector(selectProjectsPanel);
  return (
    <ToolButton id="toggleProjects" label={t('projProjects')} pressed={open} focused={open} side="left" onClick={() => d(setProjectsPanel(!open))}>
      <Svg size={16}>{ICONS.projects}</Svg>
    </ToolButton>
  );
}

export function ProjectsPanel() {
  const t = useT();
  const open = useAppSelector(selectProjectsPanel);
  const size = usePanelWidth('panel:projects:width', 300, PANEL_MIN);
  return (
    <aside id="projects-panel" hidden={!open} aria-label={t('projProjects')} style={{ width: size.width, maxWidth: '45vw' }}
      className="relative flex flex-none flex-col border-r border-border-soft bg-chrome">
      <PanelResizer edge="right" width={size.width} onWidth={size.set} onReset={size.reset} min={PANEL_MIN} label={t('projProjects')} />
      <div className="flex h-10 flex-none items-center border-b border-border-soft pl-3.5 text-[0.8125rem] font-medium text-foreground">{t('projProjects')}</div>
      <div className="flex min-h-0 flex-1 flex-col p-1.5"><ProjectsList onDone={done} allOpen /></div>
    </aside>
  );
}

export function HomeFooter() {
  const t = useT();
  const { data } = useProjects(true);
  const running = data?.running ?? [];
  const n = (s: string) => running.filter((r) => r.state === s).length;
  return (
    <div className="flex h-9 items-center gap-4 text-[0.6875rem] text-muted-foreground">
      <span>{t('homeWorking', n('working'))}</span>
      <span className={n('waiting') ? 'text-warn' : undefined}>{t('homeWaiting', n('waiting'))}</span>
      <span>{t('homeIdle', n('idle'))}</span>
    </div>
  );
}
