import { isPageAnchor } from '@nota-bene/shared';
import { definePlugin, HTML, outOf, pageRoot } from '@/sdk';
import { areaRect, resolvePage } from './anchor.ts';
import { HtmlBody } from './HtmlBody.tsx';

export const pagePlugin = definePlugin({
  id: 'page',
  fileViews: [{
    id: 'page', order: 20, match: (path, kind) => kind === 'text' && HTML.test(path), label: 'pageView', tip: 'pageViewTip',
    // the page shows every comment on its file: its text as the text does, and its places
    jump: () => true,
    render: HtmlBody,
  }],
  anchorViews: [{
    kind: 'page',
    // a page place is judged only against the page as rendered: the source view (or a page still loading) makes no claim
    orphan: (c, pane) => {
      const page = pageRoot(pane);
      return !!page && isPageAnchor(c.anchor) && !resolvePage(page.ownerDocument, c.anchor);
    },
    // the element's box, or the area through the SVG's transform, in this window's coordinates, read again on every
    // call: the page lays out on its own. null: the page is not shown, or the place is gone
    place: (c, root) => {
      const a = c.anchor;
      const doc = root?.hasAttribute('data-page-root') ? root.ownerDocument : null;
      const el = doc && isPageAnchor(a) && resolvePage(doc, a);
      if (!el || !isPageAnchor(a)) return null;
      return () => {
        if (!el.isConnected) return null;
        const r = a.box ? areaRect(el, a.box) : el.getBoundingClientRect();
        return r && r.width + r.height > 0 ? outOf(el, r) : null;
      };
    },
  }],
});
