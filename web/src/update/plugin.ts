import { definePlugin } from '@/sdk';
import { UpdateNotice } from './UpdateNotice.tsx';

export const updatePlugin = definePlugin({ id: 'update', slots: [{ slot: 'header.end', order: 20, render: UpdateNotice }] });
