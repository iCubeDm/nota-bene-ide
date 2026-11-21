import { useAppDispatch, useAppSelector, useFocusWithin, useT, withKey, useRegistry } from '@/sdk';
import { ToolButton, ICONS, Svg } from '@/sdk/ui';
import { selectTree, setTreeOpen } from './treeSlice.ts';

// module-level: the hook re-subscribes when its getter changes
const treeSheet = () => document.getElementById('tree-sheet');

/** The left strip's Files button: it toggles the tree (opening it closes the Changes panel, vcs's listener). */
export function FilesToggle() {
  const t = useT();
  const { commands } = useRegistry();
  const d = useAppDispatch();
  const open = useAppSelector(selectTree).open;
  const focused = useFocusWithin(treeSheet);
  return (
    <ToolButton id="toggleTree" label={t('files')} tip={withKey(commands, t('files'), 'hk_files')} pressed={open} focused={focused} side="left" onClick={() => d(setTreeOpen(!open))}>
      <Svg size={16}>{ICONS.dir}</Svg>
    </ToolButton>
  );
}
