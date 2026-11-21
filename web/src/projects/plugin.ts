import { definePlugin } from '@/sdk';
import { ProjectTitle } from './ProjectSwitcher.tsx';
import { ProjectRail } from './ProjectRail.tsx';
import { Starter } from './Starter.tsx';
import { Seen } from './seen.ts';

export const projectsPlugin = definePlugin({
  id: 'projects',
  slots: [
    { slot: 'header.title', order: 10, render: ProjectTitle },
    // the open projects, outermost: a stopgap before one server for every project (issue 419)
    { slot: 'panel.left', order: 10, render: ProjectRail },
    { slot: 'overlay', order: 50, render: Starter },
    { slot: 'overlay', order: 70, render: Seen },
  ],
});
