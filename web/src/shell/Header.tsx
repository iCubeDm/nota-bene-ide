import { Fragment, useEffect } from 'react';
import { getLang, chooseLang, LANGS, useT } from '@/i18n/index.ts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { selectConn, selectSession, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { openSettings, openUsage } from '@/tabs/slice.ts';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { ModelPill } from '@/controls/ModelPill.tsx';
import { SessionPicker } from '@/controls/SessionPicker.tsx';
import { UpdateNotice } from './UpdateNotice.tsx';
import { GitBranch } from './GitBranch.tsx';
import { RestartMenu } from './RestartMenu.tsx';
import { StopButton } from './StopButton.tsx';
import { RemoteDot, RemoteMenuItem } from '@/remote/RemoteMenu.tsx';
import { folderName } from '@/lib/paths.ts';
import { isMac } from './keymap.ts';
import { selectRestarting, selectSwitching } from '@/controls/slice.ts';
import { UI_SCALES } from '@nota-bene/shared';
import { type ThemeId } from '@nota-bene/shared';
import { Logo } from './Logo.tsx';
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
  useEffect(() => { document.title = `${title ? title + ' · ' : ''}${project} · Nota Bene`; }, [title, project]);
  return (
    <header className="relative z-[6] flex h-12 flex-none items-center gap-3 border-b border-border-soft bg-chrome px-4 text-xs text-muted-foreground backdrop-blur-[24px]">
      <Logo className="-mr-1 size-6 flex-none" />
      <b id="proj" className="text-[0.9375rem] font-semibold tracking-[-0.01em] text-foreground">{project}</b>
      <span id="root-path" className="min-w-0 truncate font-mono text-[0.6875rem] opacity-70">{session?.root ?? ''}</span>
      <GitBranch />
      <span className="flex-1" />
      <span id="conn" className="text-warn">{conn === 'connecting' ? t('connecting') : conn === 'closed' ? t('offline') : switching ? t(restarting ? 'restarting' : 'switching') : ''}</span>
      <UpdateNotice />
      <SessionPicker />
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
            title={t('settingsTip')}
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
            <DropdownMenuSubTrigger id="themeMenu" title={t('themeTip')} className={row}>
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
          <DropdownMenuItem id="usageMenu" title={t('usageTip')} onSelect={() => d(openUsage())} className={`${row} [&>svg]:text-accent-usage`}>
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
