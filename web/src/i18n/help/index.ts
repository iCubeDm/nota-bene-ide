import type { UiLang } from '@nota-bene/shared';
import { helpDe } from './de.ts';
import { helpEn } from './en.ts';
import { helpEs } from './es.ts';
import { helpPtBR } from './pt-BR.ts';
import { helpRu } from './ru.ts';
import { helpZhCN } from './zh-CN.ts';

/** The reference's groups (issue 464). */
export type HelpArea = 'chat' | 'comments' | 'files' | 'markup' | 'edit' | 'voice' | 'projects' | 'settings' | 'phone';

/**
 * The help dictionary (issue 463): one entry per feature, the explanation a tooltip no longer carries (a tooltip only
 * names the action and its key). `guide`: the heading of docs/guide.md the entry links to, as its anchor. Not shown yet:
 * the in-app reference of issue 464 renders it.
 */
export const HELP_ENTRIES = {
  compact: { area: 'chat', guide: 'chat' },
  compactEstimate: { area: 'chat', guide: 'chat' },
  clear: { area: 'chat', guide: 'chat' },
  idleCompaction: { area: 'chat', guide: 'chat' },
  contextMeter: { area: 'chat', guide: 'chat' },
  attach: { area: 'chat', guide: 'attaching-images-to-a-message' },
  sessions: { area: 'chat', guide: 'sessions-and-history' },
  model: { area: 'chat', guide: 'chat' },
  mode: { area: 'chat', guide: 'agent-permission-modes' },
  restartAgent: { area: 'chat', guide: 'from-a-terminal-nota-bene' },
  restartServer: { area: 'projects', guide: 'from-a-terminal-nota-bene' },
  codeUpdated: { area: 'projects', guide: 'from-a-terminal-nota-bene' },
  stopWindow: { area: 'projects', guide: 'from-claude-code-nb' },
  taskBackground: { area: 'chat', guide: 'subagents-and-background-tasks' },
  taskStopAll: { area: 'chat', guide: 'subagents-and-background-tasks' },
  pageScripts: { area: 'files', guide: 'html-pages-and-diagrams' },
  markupMask: { area: 'markup', guide: 'viewing-and-marking-up-images-and-video' },
  voiceSend: { area: 'voice', guide: 'voice-messages' },
  cutSelect: { area: 'edit', guide: 'video-edits-nbcutjson' },
  cutBlade: { area: 'edit', guide: 'video-edits-nbcutjson' },
  cutClip: { area: 'edit', guide: 'video-edits-nbcutjson' },
  cutSplit: { area: 'edit', guide: 'video-edits-nbcutjson' },
  cutComment: { area: 'edit', guide: 'video-edits-nbcutjson' },
  cutGain: { area: 'edit', guide: 'video-edits-nbcutjson' },
  cutPlace: { area: 'edit', guide: 'video-edits-nbcutjson' },
  cutClipLight: { area: 'edit', guide: 'video-edits-nbcutjson' },
  settingsMenu: { area: 'settings', guide: 'settings' },
  usageTotals: { area: 'settings', guide: 'usage' },
  usageExtra: { area: 'settings', guide: 'usage' },
  usageTank: { area: 'settings', guide: 'usage' },
  usageTank5h: { area: 'settings', guide: 'usage' },
  projectRail: { area: 'projects', guide: 'projects-switching-opening-creating' },
  sounds: { area: 'settings', guide: 'settings' },
  auditLog: { area: 'settings', guide: 'audit-log' },
} as const satisfies Record<string, { area: HelpArea; guide: string }>;

export type HelpKey = keyof typeof HELP_ENTRIES;

export const HELP: Record<UiLang, Record<HelpKey, string>> = { en: helpEn, ru: helpRu, 'zh-CN': helpZhCN, es: helpEs, 'pt-BR': helpPtBR, de: helpDe };
