import { selectTabs, useAppDispatch, useAppSelector, useFocusWithin, useT } from '@/sdk';
import { ToolButton } from '@/sdk/ui';
import { openChanges, openLog } from '@/tabs/slice.ts';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { setTreeOpen } from '@/files/treeSlice.ts';
import { setPanel, useVcsUi } from './store.ts';

// module-level getters: the hook re-subscribes when its getter changes
const changesSheet = () => document.getElementById('changes-sheet');
const logPane = () => document.querySelector('[data-pane="log"]');

/** The left strip's Changes and log buttons, in a repository only. */
export function VcsToggles() {
  const t = useT();
  const d = useAppDispatch();
  const ui = useVcsUi();
  const active = useAppSelector(selectTabs).active;
  const inChanges = useFocusWithin(changesSheet);
  const inLog = useFocusWithin(logPane);
  if (!ui.hasRepo) return null;
  return (
    <>
      <ToolButton id="toggleChanges" label={t('vcsChanges')} pressed={ui.panel} focused={inChanges} side="left" onClick={() => { d(setTreeOpen(false)); setPanel(!ui.panel); if (!ui.panel) d(openChanges()); }}>
        <Svg size={16}>{ICONS.changes}</Svg>
      </ToolButton>
      <ToolButton id="toggleLog" label={t('vcsLog')} pressed={active === 'log'} focused={inLog} side="left" onClick={() => d(openLog())}>
        <Svg size={16}>{ICONS.log}</Svg>
      </ToolButton>
    </>
  );
}
