import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { ProjectTitle } from './ProjectSwitcher.tsx';
import { ProjectRail } from './ProjectRail.tsx';
import { Starter } from './Starter.tsx';
import { Seen } from './seen.ts';
import { openFolder, projectsResource, projectsSlice, reasonText, selectProjectsMenu, setProjectsMenu } from './api.ts';
import { projectsSettings } from './settings.tsx';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof projectsSlice> {}
}

export const projectsPlugin = definePlugin({
  id: 'projects',
  slices: [projectsSlice],
  slots: [
    { slot: 'header.title', order: 10, render: ProjectTitle },
    // the open projects, outermost: a stopgap before one server for every project (issue 419)
    { slot: 'panel.left', order: 10, render: ProjectRail },
    { slot: 'overlay', order: 50, render: Starter },
    { slot: 'overlay', order: 70, render: Seen },
  ],
  // Alt+P, in a field too (also on a Mac, where Option+P types π): the project switcher in the header
  commands: [{ id: 'hk_projects', codes: ['KeyP'], mods: { alt: true }, inFields: true, order: 70, run: ({ store }) => void store.dispatch(setProjectsMenu(!selectProjectsMenu(store.getState()))) }],
  settings: projectsSettings,
  resources: [projectsResource],
  projects: { openFolder: async (dir, provider) => { const why = await openFolder(dir, provider); return why && reasonText(why); } },
});
