import { isCutAnchor } from '@nota-bene/shared';
import { isCutPath } from '@nota-bene/shared/cut';
import { definePlugin } from '@/sdk';
import { CutView } from './CutBody.tsx';

export const cutPlugin = definePlugin({
  id: 'cut',
  fileViews: [{
    // an edit (`*.nbcut.json`) opens as its timeline; a comment on the timeline (issue 430) is the timeline's
    id: 'cut', order: 10, match: (path, kind) => kind === 'text' && isCutPath(path), label: 'cutTimeline', tip: 'cutViewTip', writes: true,
    jump: (c) => isCutAnchor(c.anchor),
    render: CutView,
  }],
});
