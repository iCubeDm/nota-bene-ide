import { useAppDispatch, useAppSelector, useFocusWithin, useT, withKey } from '@/sdk';
import { ToolButton } from '@/sdk/ui';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { setPanel } from '@/vcs/store.ts';
import { selectTree, setTreeOpen } from './treeSlice.ts';

// module-level: the hook re-subscribes when its getter changes
const treeSheet = () => document.getElementById('tree-sheet');

/** The left strip's Files button: it toggles the tree, closing the Changes panel. */
export function FilesToggle() {
  const t = useT();
  const d = useAppDispatch();
  const open = useAppSelector(selectTree).open;
  const focused = useFocusWithin(treeSheet);
  return (
    <ToolButton id="toggleTree" label={t('files')} tip={withKey(t('files'), 'hk_files')} pressed={open} focused={focused} side="left" onClick={() => { setPanel(false); d(setTreeOpen(!open)); }}>
      <Svg size={16}>{ICONS.dir}</Svg>
    </ToolButton>
  );
}
