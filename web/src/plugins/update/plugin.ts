import { definePlugin } from '@/sdk';
import { statusResource, UpdateNotice } from './UpdateNotice.tsx';
import { autoResource, updateSettings } from './settings.tsx';

export const updatePlugin = definePlugin({
  id: 'update', slots: [{ slot: 'header.end', order: 20, render: UpdateNotice }],
  settings: updateSettings, resources: [statusResource, autoResource],
});
