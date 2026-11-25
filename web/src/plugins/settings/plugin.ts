import { definePlugin, type ViewTab } from '@/sdk';
import { SettingsMenuRow, settingsTab } from './SettingsView.tsx';
import { SETTINGS, SETTINGS_RESOURCES } from './sections.tsx';

declare module '@/sdk' {
  interface TabKinds { settings: ViewTab<'settings'> }
}

export const settingsPlugin = definePlugin({
  id: 'settings',
  tabs: [settingsTab],
  // last in the header's settings menu, under a line
  slots: [{ slot: 'header.menu', order: 90, render: SettingsMenuRow }],
  settings: SETTINGS,
  resources: SETTINGS_RESOURCES,
});
