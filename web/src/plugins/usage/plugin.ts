import { definePlugin, type ViewTab } from '@/sdk';
import { UsageMenuRow, usageResource, usageTab } from './UsageView.tsx';

declare module '@/sdk' {
  interface TabKinds { usage: ViewTab<'usage'> }
}

export const usagePlugin = definePlugin({
  id: 'usage',
  tabs: [usageTab],
  slots: [{ slot: 'header.menu', order: 20, render: UsageMenuRow }],
  resources: [usageResource],
});
