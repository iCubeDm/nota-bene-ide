import { definePlugin, HTML } from '@/sdk';
import { HtmlBody } from './HtmlBody.tsx';

export const pagePlugin = definePlugin({
  id: 'page',
  fileViews: [{
    id: 'page', order: 20, match: (path, kind) => kind === 'text' && HTML.test(path), label: 'pageView', tip: 'pageViewTip',
    // the page shows every comment on its file: its text as the text does, and its places
    jump: () => true,
    render: HtmlBody,
  }],
});
