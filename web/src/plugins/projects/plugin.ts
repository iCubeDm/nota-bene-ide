import { AGENT_ID, type AgentProvider } from '@nota-bene/shared';
import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin, serverEvent } from '@/sdk';
import { ProjectTitle } from './ProjectSwitcher.tsx';
import { ProjectRail } from './ProjectRail.tsx';
import { Starter } from './Starter.tsx';
import { Seen } from './seen.ts';
import { nav, openFolder, projectsResource, projectsSlice, reasonText, selectProjectsMenu, setProjectsMenu } from './api.ts';
import { projectsSettings } from './settings.tsx';

declare module '@/sdk' {
  interface Services { projects: ProjectsService }
  interface PluginState extends WithSlice<typeof projectsSlice> {}
}

/** The projects' windows as other plugins open them (issue 545), provided by the projects plugin. */
export interface ProjectsService {
  /** opens the folder in a window of its own (this tab moves there); the refusal, in words, or null */
  openFolder(dir: string, provider: AgentProvider): Promise<string | null>;
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
  // epic 383: `nota-bene` or `/nb` opened another agent of this tab's server: the tab moves to it (same origin, logged in)
  listeners: (start) => {
    start({ actionCreator: serverEvent, effect: ({ payload: ev }) => { if (ev.kind === 'open-agent' && AGENT_ID.test(ev.agent)) nav.go(`/a/${ev.agent}/`); } });
  },
  projects: { openFolder: async (dir, provider) => { const why = await openFolder(dir, provider); return why && reasonText(why); } },
});
