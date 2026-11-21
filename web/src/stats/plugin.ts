import { definePlugin } from '@/sdk';
import { CtxNudge } from './CtxNudge.tsx';
import { Meters } from './Meters.tsx';

export const statsPlugin = definePlugin({
  id: 'stats',
  slots: [{ slot: 'composer.status', order: 10, render: CtxNudge }, { slot: 'composer.end', order: 20, render: Meters }],
});
