// The plugins compiled into this bundle (issue 511), in order: their slices are injected in this order.
import type { Plugin } from '@/sdk';
import { commentsPlugin } from './plugins/comments/plugin.ts';
import { composerPlugin } from './plugins/composer/plugin.ts';
import { filesPlugin } from './plugins/files/plugin.ts';
import { controlsPlugin } from './plugins/controls/plugin.ts';
import { statsPlugin } from './plugins/stats/plugin.ts';
import { remotePlugin } from './plugins/remote/plugin.ts';
import { tasksPlugin } from './plugins/tasks/plugin.ts';
import { mediaPlugin } from './plugins/media/plugin.ts';
import { cutPlugin } from './plugins/cut/plugin.ts';
import { pagePlugin } from './plugins/page/plugin.ts';
import { voicePlugin } from './plugins/voice/plugin.ts';
import { attachmentsPlugin } from './plugins/attachments/plugin.ts';
import { feedPlugin } from './plugins/feed/plugin.ts';
import { subagentPlugin } from './plugins/subagent/plugin.ts';
import { diagramPlugin } from './plugins/diagram/plugin.ts';
import { settingsPlugin } from './plugins/settings/plugin.ts';
import { usagePlugin } from './plugins/usage/plugin.ts';
import { vcsPlugin } from './plugins/vcs/plugin.ts';
import { updatePlugin } from './plugins/update/plugin.ts';
import { projectsPlugin } from './plugins/projects/plugin.ts';

export const PLUGINS: readonly Plugin[] = [commentsPlugin, composerPlugin, filesPlugin, controlsPlugin, statsPlugin, remotePlugin, tasksPlugin, mediaPlugin, cutPlugin, pagePlugin, voicePlugin, attachmentsPlugin, feedPlugin, subagentPlugin, diagramPlugin, settingsPlugin, usagePlugin, vcsPlugin, updatePlugin, projectsPlugin];
