import { definePlugin } from '@/sdk';
import { usageTab } from './UsageView.tsx';

export const usagePlugin = definePlugin({ id: 'usage', tabs: [usageTab] });
