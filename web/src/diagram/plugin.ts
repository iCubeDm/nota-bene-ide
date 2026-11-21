import { definePlugin } from '@/sdk';
import { diagramTab } from './DiagramView.tsx';

export const diagramPlugin = definePlugin({ id: 'diagram', tabs: [diagramTab] });
