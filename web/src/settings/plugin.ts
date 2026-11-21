import { definePlugin } from '@/sdk';
import { settingsTab } from './SettingsView.tsx';

export const settingsPlugin = definePlugin({ id: 'settings', tabs: [settingsTab] });
