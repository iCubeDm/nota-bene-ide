// The plugins compiled into this bundle (issue 511), in order: their slices are injected in this order.
import type { Plugin } from '@/sdk';
import { commentsPlugin } from './comments/plugin.ts';
import { composerPlugin } from './composer/plugin.ts';
import { filesPlugin } from './files/plugin.ts';
import { controlsPlugin } from './controls/plugin.ts';
import { statsPlugin } from './stats/plugin.ts';
import { remotePlugin } from './remote/plugin.ts';
import { tasksPlugin } from './tasks/plugin.ts';
import { mediaPlugin } from './media/plugin.ts';
import { voicePlugin } from './voice/plugin.ts';
import { attachmentsPlugin } from './attachments/plugin.ts';
import { feedPlugin } from './feed/plugin.ts';
import { subagentPlugin } from './subagent/plugin.ts';
import { diagramPlugin } from './diagram/plugin.ts';
import { settingsPlugin } from './settings/plugin.ts';
import { usagePlugin } from './usage/plugin.ts';
import { vcsPlugin } from './vcs/plugin.ts';
import { updatePlugin } from './update/plugin.ts';
import { projectsPlugin } from './projects/plugin.ts';

export const PLUGINS: readonly Plugin[] = [commentsPlugin, composerPlugin, filesPlugin, controlsPlugin, statsPlugin, remotePlugin, tasksPlugin, mediaPlugin, voicePlugin, attachmentsPlugin, feedPlugin, subagentPlugin, diagramPlugin, settingsPlugin, usagePlugin, vcsPlugin, updatePlugin, projectsPlugin];
