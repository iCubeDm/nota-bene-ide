import { useAppDispatch, useAppSelector, useFocusWithin, useT, withKey } from '@/sdk';
import { ToolButton } from '@/sdk/ui';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { selectCommentsUi, selectPending, setPanelOpen } from './slice.ts';

// module-level: the hook re-subscribes when its getter changes
const commentsPanel = () => document.getElementById('comments');

/** The right strip's Comments button, with the count of comments not sent yet. */
export function CommentsToggle() {
  const t = useT();
  const d = useAppDispatch();
  const open = useAppSelector(selectCommentsUi).panelOpen;
  const n = useAppSelector(selectPending).length;
  const focused = useFocusWithin(commentsPanel);
  const label = n ? t('commentsN', n) : t('comments');
  return (
    <ToolButton id="toggleComments" label={label} tip={withKey(label, 'hk_comments')} pressed={open} focused={focused} side="right" onClick={() => d(setPanelOpen(!open))}>
      <Svg size={16}>{ICONS.comments}</Svg>
      {n > 0 && (
        <span data-testid="pending-badge" className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-nb-accent px-1 text-center text-[0.5625rem] font-semibold leading-3.5 text-background">
          {n}
        </span>
      )}
    </ToolButton>
  );
}
