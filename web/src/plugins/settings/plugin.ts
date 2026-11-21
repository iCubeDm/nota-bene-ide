import { definePlugin } from '@/sdk';
import { settingsTab } from './SettingsView.tsx';
import { SETTINGS, SETTINGS_RESOURCES } from './sections.tsx';

export const settingsPlugin = definePlugin({ id: 'settings', tabs: [settingsTab], settings: SETTINGS, resources: SETTINGS_RESOURCES });
