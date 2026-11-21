import { definePlugin } from '@/sdk';
import { changesTab } from './ChangesView.tsx';
import { logTab } from './LogView.tsx';

export const vcsPlugin = definePlugin({ id: 'vcs', tabs: [changesTab, logTab] });
