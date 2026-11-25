import { AGENT_ID, agentPath, type AgentProvider } from '@nota-bene/shared';
import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin, serverEvent } from '@/sdk';
import { AgentClose } from './AgentClose.tsx';
import { AppIcon, shortcutResource } from './AppIcon.tsx';
import { Inbox } from './Inbox.tsx';
import { ProjectTitle } from './ProjectSwitcher.tsx';
import { ProjectRail } from './ProjectRail.tsx';
import { HomeFooter, HomeTitle, ProjectsPanel, ProjectsToggle } from './HomeParts.tsx';
import { Starter } from './Starter.tsx';
import { Seen } from './seen.ts';
import { installedResource, nav, openFolder, othersWorking, projectsResource, projectsSlice, reasonText, selectProjectsMenu, setProjectsMenu } from './api.ts';
import { projectsSettings } from './settings.tsx';

declare module '@/sdk' {
  interface Services { projects: ProjectsService }
  interface PluginState extends WithSlice<typeof projectsSlice> {}
}

/** The projects' windows as other plugins open them (issue 545), provided by the projects plugin. */
export interface ProjectsService {
  /** opens the folder in a window of its own (this tab moves there); the refusal, in words, or null */
  openFolder(dir: string, provider: AgentProvider): Promise<string | null>;
  /** whether an agent of this computer other than this page's is working now */
  othersWorking(): Promise<boolean>;
}

export const projectsPlugin = definePlugin({
  id: 'projects',
  slices: [projectsSlice],
  slots: [
    { slot: 'header.title', order: 10, render: ProjectTitle },
    // issue 661: the chat's tab, with ✕ closing this page's agent
    { slot: 'tabs.chat', order: 10, render: AgentClose },
    // the open projects, outermost: a stopgap before one server for every project (issue 419)
    { slot: 'panel.left', order: 10, render: ProjectRail, on: 'both' },
    { slot: 'overlay', order: 50, render: Starter, on: 'both' },
    // issue 639: the server's home page; issue 651: its inbox
    { slot: 'home', order: 10, render: Inbox, on: 'home' },
    // issue 651: the home page's title, Projects panel and counts
    { slot: 'header.title', order: 20, render: HomeTitle, on: 'home' },
    { slot: 'strip.left', order: 5, render: ProjectsToggle, on: 'home' },
    { slot: 'panel.left', order: 25, render: ProjectsPanel, on: 'home' },
    { slot: 'footer', order: 5, render: HomeFooter, on: 'home' },
    // epic 383: the app icon's offer, a notification
    { slot: 'overlay', order: 75, render: AppIcon },
    { slot: 'overlay', order: 70, render: Seen },
  ],
  // Alt+P, in a field too (also on a Mac, where Option+P types π): the project switcher in the header
  commands: [
    { id: 'hk_projects', codes: ['KeyP'], mods: { alt: true }, inFields: true, order: 70, run: ({ store }) => void store.dispatch(setProjectsMenu(!selectProjectsMenu(store.getState()))) },
  ],
  settings: projectsSettings,
  resources: [projectsResource, installedResource, shortcutResource],
  // epic 383: `nota-bene` or `/nb` opened another agent of this tab's server: the tab moves to it (same origin, logged in)
  listeners: (start) => {
    start({ actionCreator: serverEvent, effect: ({ payload: ev }) => { if (ev.kind === 'open-agent' && AGENT_ID.test(ev.agent)) nav.go(`${agentPath(ev.agent)}/`); } });
  },
  projects: { openFolder: async (dir, provider) => { const why = await openFolder(dir, provider); return why && reasonText(why); }, othersWorking },
});
