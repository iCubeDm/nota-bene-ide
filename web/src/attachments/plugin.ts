import { definePlugin } from '@/sdk';
import { ImagesPart } from './Attachments.tsx';

export const attachmentsPlugin = definePlugin({ id: 'attachments', userParts: [{ id: 'images', order: 30, render: ImagesPart }] });
