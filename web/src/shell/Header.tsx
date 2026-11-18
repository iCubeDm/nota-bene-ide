import { Fragment, useRef } from 'react';
import { getLang, chooseLang, LANGS, useT } from '@/i18n/index.ts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { selectConn, selectSession, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { openSettings, openUsage } from '@/tabs/slice.ts';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { ModelPill } from '@/controls/ModelPill.tsx';
import { UpdateNotice } from './UpdateNotice.tsx';
import { GitBranch } from './GitBranch.tsx';
import { RestartMenu } from './RestartMenu.tsx';
import { StopButton } from './StopButton.tsx';
import { RemoteDot, RemoteMenuItem } from '@/remote/RemoteMenu.tsx';
import { folderName, shortHome } from '@/lib/paths.ts';
import { toast } from './toast.ts';
import { useTabAligned } from './tabAlign.ts';
import { isMac } from './keymap.ts';
import { selectRestarting, selectSwitching } from '@/controls/slice.ts';
import { UI_SCALES } from '@nota-bene/shared';
import { type ThemeId } from '@nota-bene/shared';
import { Logo } from './Logo.tsx';
import { ProjectSwitcher } from '@/projects/ProjectSwitcher.tsx';
import { theme, THEME_GROUPS, THEME_NAMES, useTheme } from './theme.ts';
import { scaleLabel, uiScale, useUiScale } from './uiScale.ts';

const row = 'gap-2.5 px-2 py-1.5 text-[0.8125rem] text-foreground [&>svg]:text-muted-foreground';
const stepBtn = 'grid size-6 cursor-pointer place-items-center rounded-md text-[0.9375rem] leading-none text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent';
const isMacLabel = (k: string) => `${isMac() ? '⌥' : 'Alt+'}${k}`;

export function Header() {
  const t = useT();
  const d = useAppDispatch();
  const lang = getLang();
  const scale = useUiScale();
  const themeId = useTheme();
  const conn = useAppSelector(selectConn);
  const session = useAppSelector(selectSession);
  const switching = useAppSelector(selectSwitching);
  const restarting = useAppSelector(selectRestarting);
  // the project, not the app, names the window: several windows on different projects must be told apart
  const project = (session && folderName(session.root)) || 'Nota Bene';
  const title = session?.title ?? null;
  // the tab's title; the switcher puts the other projects' badge in front of it
  const headerRef = useRef<HTMLElement>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  const gitLeft = useTabAligned(headerRef, blockRef);
  const windowTitle = `${title ? title + ' · ' : ''}${project} · Nota Bene`;
  return (
    <header ref={headerRef} className="relative z-[6] flex h-12 flex-none items-center gap-3 border-b border-border-soft bg-chrome px-4 text-xs text-muted-foreground backdrop-blur-[24px]">
      <Logo className="-mr-1 size-6 flex-none" />
      {/* the project's name opens the switcher: every window of every provider, recent folders, open or create one */}
      {/* the path under the name, one block; pr-6 keeps room for the badge right of the ▾. The name alone sets the width
          (w-0 min-w-full: the path adds none, so the git branch never moves for a long one); the path shows its end, cut on
          the left (dir rtl over an ltr run keeps its slashes in order); the home folder is ~, the copy icon beside it copies the whole path. A floor of 14rem
          keeps a short name from cutting the path to nothing; the branch moves only for a name longer than that */}
      <div ref={blockRef} data-proj-block className="flex min-w-[min(14rem,30vw)] flex-col items-start pr-6">
        <ProjectSwitcher project={project} windowTitle={windowTitle} />
        <div className="group flex w-0 min-w-full items-center gap-0.5">
          <span id="root-path" dir="rtl" className="min-w-0 truncate px-1 text-left font-mono text-[0.625rem] leading-3 opacity-70 group-hover:opacity-100"><span dir="ltr">{session?.root ? shortHome(session.root) : ''}</span></span>
          {/* the copy icon shows on hover of the path (issue 463) */}
          {session?.root && (
            <button type="button" id="copy-root" aria-label={t('copyPath')} title={t('copyPath')}
              onClick={() => void navigator.clipboard?.writeText(session.root).then(() => toast(t('codeCopied'), shortHome(session.root)))}
              className="grid size-3.5 flex-none cursor-pointer place-items-center rounded opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100">
              <Svg size={10}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Svg>
            </button>
          )}
        </div>
      </div>
      {/* over the middle column, its left edge on the first tab's (tabAlign.ts); out of the flow, so nothing else moves */}
      <div data-git-slot className="absolute inset-y-0 flex items-center" style={{ left: gitLeft ?? undefined, visibility: gitLeft === null ? 'hidden' : undefined }}>
        <GitBranch />
      </div>
      <span className="flex-1" />
      <span id="conn" className="text-warn">{conn === 'connecting' ? t('connecting') : conn === 'closed' ? t('offline') : switching ? t(restarting ? 'restarting' : 'switching') : ''}</span>
      <UpdateNotice />
      {/* enabled while busy: the escape hatch for a stuck agent (R-M4-4); only a running switch/restart disables it */}
      <RestartMenu />
      <ModelPill />
      <span id="session" className="font-mono text-[0.6875rem]">{session?.id?.slice(0, 8) ?? ''}</span>
      {/* the settings at hand: language and scale here, the rest in the Settings tab */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            id="settingsBtn"
            aria-label={t('settings')}
            title={t('settings')}
            className="relative grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Svg size={15}>{ICONS.settings}</Svg>
            <RemoteDot />
          </button>
        </DropdownMenuTrigger>
        {/* rows as in a browser's side menu: an icon, the label, then the value, the steps or the submenu arrow */}
        <DropdownMenuContent align="end" className="min-w-60">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger id="langMenu" className={row}>
              <Svg size={15}>{ICONS.globe}</Svg>
              <span className="flex-1">{t('langTip')}</span>
              <span className="text-muted-foreground">{LANGS.find((l) => l.id === lang)?.name}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {LANGS.map((l) => (
                <DropdownMenuItem key={l.id} data-lang={l.id} onSelect={() => chooseLang(l.id)} className={l.id === lang ? 'font-semibold text-foreground' : undefined}>
                  {l.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger id="themeMenu" className={row}>
              <Svg size={15}>{ICONS.palette}</Svg>
              <span className="flex-1">{t('theme')}</span>
              <span className="text-muted-foreground">{THEME_NAMES[themeId]}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={themeId} onValueChange={(id) => theme.choose(id as ThemeId)}>
                {THEME_GROUPS.map((g, i) => (
                  <Fragment key={g.kind}>
                    {i > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel data-theme-heading>{t(g.head)}</DropdownMenuLabel>
                    {g.ids.map((id) => (
                      <DropdownMenuRadioItem key={id} value={id} data-theme-id={id}>
                        {THEME_NAMES[id]}
                      </DropdownMenuRadioItem>
                    ))}
                  </Fragment>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {/* not a menu item: a step keeps the menu open, so the change is seen while choosing */}
          <div className={`${row} flex items-center rounded-md`}>
            <Svg size={15}>{ICONS.textSize}</Svg>
            <span className="flex-1">{t('defScale')}</span>
            <span className="-mr-1 flex items-center">
              <button type="button" id="scaleDown" aria-label={t('scaleSmaller')} title={`${t('scaleSmaller')} (${isMacLabel('−')})`} disabled={scale === UI_SCALES[0]}
                onClick={() => uiScale.step(-1)} className={stepBtn}>−</button>
              <span id="scaleValue" className="w-10 text-center tabular-nums text-muted-foreground">{scaleLabel(scale, lang)}</span>
              <button type="button" id="scaleUp" aria-label={t('scaleLarger')} title={`${t('scaleLarger')} (${isMacLabel('=')})`} disabled={scale === UI_SCALES[UI_SCALES.length - 1]}
                onClick={() => uiScale.step(1)} className={stepBtn}>+</button>
            </span>
          </div>
          <RemoteMenuItem className={row} />
          <DropdownMenuItem id="usageMenu" onSelect={() => d(openUsage())} className={`${row} [&>svg]:text-accent-usage`}>
            <Svg size={15}>{ICONS.usage}</Svg>
            <span className="flex-1">{t('usage')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem id="allSettings" onSelect={() => d(openSettings())} className={row}>
            <Svg size={15}>{ICONS.settings}</Svg>
            <span className="flex-1">{t('allSettings')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <StopButton />
    </header>
  );
}
