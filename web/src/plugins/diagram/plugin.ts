import { definePlugin } from '@/sdk';
import { DIAGRAM_BLOCKS } from './codeBlocks.ts';
import { diagramTab } from './DiagramView.tsx';

export const diagramPlugin = definePlugin({ id: 'diagram', tabs: [diagramTab], codeBlocks: DIAGRAM_BLOCKS });
