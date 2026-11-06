import { useEffect } from 'react';
import { getLang, chooseLang, LANGS, useT } from '@/i18n/index.ts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { selectConn, selectSession, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { openSettings, openUsage } from '@/tabs/slice.ts';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { ModelPill } from '@/controls/ModelPill.tsx';
import { SessionPicker } from '@/controls/SessionPicker.tsx';
import { UpdateNotice } from './UpdateNotice.tsx';
import { GitBranch } from './GitBranch.tsx';
import { RestartMenu } from './RestartMenu.tsx';
import { isMac } from './keymap.ts';
import { selectRestarting, selectSwitching } from '@/controls/slice.ts';
import { UI_SCALES } from '@nota-bene/shared';
import { scaleLabel, uiScale, useUiScale } from './uiScale.ts';

const stepBtn = 'grid size-6 cursor-pointer place-items-center rounded-md border border-border-soft text-foreground hover:bg-muted disabled:cursor-default disabled:opacity-40';
const isMacLabel = (k: string) => `${isMac() ? '⌥' : 'Alt+'}${k}`;

export function Header() {
  const t = useT();
  const d = useAppDispatch();
  const lang = getLang();
  const scale = useUiScale();
  const conn = useAppSelector(selectConn);
  const session = useAppSelector(selectSession);
  const switching = useAppSelector(selectSwitching);
  const restarting = useAppSelector(selectRestarting);
  // the project, not the app, names the window: several windows on different projects must be told apart
  const project = session?.root.split('/').filter(Boolean).pop() ?? 'Nota Bene';
  const title = session?.title ?? null;
  useEffect(() => { document.title = `${title ? title + ' · ' : ''}${project} · Nota Bene`; }, [title, project]);
  return (
    <header className="relative z-[6] flex h-12 flex-none items-center gap-3 border-b border-border-soft bg-chrome px-4 text-xs text-muted-foreground backdrop-blur-[24px]">
      <img id="logo" src="/icon.svg" alt="Nota Bene" className="-mr-1 size-6" />
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
      <button
        type="button"
        id="usageBtn"
        aria-label={t('usage')}
        title={t('usageTip')}
        onClick={() => d(openUsage())}
        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Svg size={15}>{ICONS.usage}</Svg>
      </button>
      {/* the settings at hand: language and scale here, the rest in the Settings tab */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            id="settingsBtn"
            aria-label={t('settings')}
            title={t('settingsTip')}
            className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Svg size={15}>{ICONS.settings}</Svg>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger id="langMenu">
              <Svg size={13}>{ICONS.globe}</Svg>
              <span>{t('langTip')}</span>
              <span className="ml-auto text-muted-foreground">{LANGS.find((l) => l.id === lang)?.name}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {LANGS.map((l) => (
                <DropdownMenuItem key={l.id} data-lang={l.id} onSelect={() => chooseLang(l.id)} className={l.id === lang ? 'font-semibold text-foreground' : undefined}>
                  {l.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {/* not menu items: a step keeps the menu open, so the change is seen while choosing */}
          <div className="flex items-center gap-2 px-2 py-1 text-xs">
            <span className="flex-1">{t('defScale')}</span>
            <button type="button" id="scaleDown" aria-label={t('scaleSmaller')} title={`${t('scaleSmaller')} (${isMacLabel('−')})`} disabled={scale === UI_SCALES[0]}
              onClick={() => uiScale.step(-1)} className={stepBtn}>−</button>
            <span id="scaleValue" className="w-11 text-center tabular-nums text-foreground">{scaleLabel(scale, lang)}</span>
            <button type="button" id="scaleUp" aria-label={t('scaleLarger')} title={`${t('scaleLarger')} (${isMacLabel('=')})`} disabled={scale === UI_SCALES[UI_SCALES.length - 1]}
              onClick={() => uiScale.step(1)} className={stepBtn}>+</button>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem id="allSettings" onSelect={() => d(openSettings())}>{t('allSettings')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
