import { definePlugin } from '@/sdk';
import { usageResource, usageTab } from './UsageView.tsx';

export const usagePlugin = definePlugin({ id: 'usage', tabs: [usageTab], resources: [usageResource] });
