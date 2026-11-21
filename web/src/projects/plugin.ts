import { definePlugin } from '@/sdk';
import { ProjectTitle } from './ProjectSwitcher.tsx';
import { ProjectRail } from './ProjectRail.tsx';
import { Starter } from './Starter.tsx';
import { Seen } from './seen.ts';
import { projectsMenu, projectsResource } from './api.ts';
import { projectsSettings } from './settings.tsx';

export const projectsPlugin = definePlugin({
  id: 'projects',
  slots: [
    { slot: 'header.title', order: 10, render: ProjectTitle },
    // the open projects, outermost: a stopgap before one server for every project (issue 419)
    { slot: 'panel.left', order: 10, render: ProjectRail },
    { slot: 'overlay', order: 50, render: Starter },
    { slot: 'overlay', order: 70, render: Seen },
  ],
  // Alt+P, in a field too (also on a Mac, where Option+P types π): the project switcher in the header
  commands: [{ id: 'hk_projects', codes: ['KeyP'], mods: { alt: true }, inFields: true, order: 70, run: () => projectsMenu.toggle() }],
  settings: projectsSettings,
  resources: [projectsResource],
});
