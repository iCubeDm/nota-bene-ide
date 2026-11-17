import type { UiLang } from '@nota-bene/shared';
import type { ru } from '../ru.ts';
import { helpDe } from './de.ts';
import { helpEn } from './en.ts';
import { helpEs } from './es.ts';
import { helpPtBR } from './pt-BR.ts';
import { helpRu } from './ru.ts';
import { helpZhCN } from './zh-CN.ts';

/** The reference's groups (issue 464). */
export type HelpArea = 'chat' | 'comments' | 'files' | 'markup' | 'edit' | 'voice' | 'projects' | 'settings' | 'phone';

/** A key of the UI dictionary. */
export type TKey = keyof typeof ru;

/**
 * The help dictionary (issue 463): one entry per feature, the explanation a tooltip no longer carries (a tooltip only
 * names the action and its key). `guide`: the heading of docs/guide.md the entry links to, as its anchor; `tips`: the
 * tooltips (UI keys) that link to the entry. Not shown yet: the in-app reference of issue 464 renders it.
 */
export const HELP_ENTRIES = {
  compact: { area: 'chat', guide: 'chat', tips: ['compactTip'] },
  compactEstimate: { area: 'chat', guide: 'chat', tips: ['compactingTip'] },
  clear: { area: 'chat', guide: 'chat', tips: ['clearTip'] },
  idleCompaction: { area: 'chat', guide: 'chat', tips: ['idleTip', 'idleBlocked'] },
  contextMeter: { area: 'chat', guide: 'chat', tips: ['ctxTip'] },
  attach: { area: 'chat', guide: 'attaching-any-other-file', tips: ['attach'] },
  sessions: { area: 'chat', guide: 'sessions-and-history', tips: ['sessTip', 'sessTipCodex', 'sessTipOmp'] },
  model: { area: 'chat', guide: 'chat', tips: ['modelTip'] },
  mode: { area: 'chat', guide: 'agent-permission-modes', tips: ['modeTip'] },
  restartAgent: { area: 'chat', guide: 'sessions-and-history', tips: ['restartTip'] },
  restartServer: { area: 'projects', guide: 'from-a-terminal-nota-bene', tips: ['restartServer'] },
  codeUpdated: { area: 'projects', guide: 'from-a-terminal-nota-bene', tips: ['codeUpdatedTip'] },
  stopWindow: { area: 'projects', guide: 'settings', tips: ['stopWindow'] },
  taskBackground: { area: 'chat', guide: 'subagents-and-background-tasks', tips: ['taskBackgroundTip'] },
  taskStopAll: { area: 'chat', guide: 'subagents-and-background-tasks', tips: ['taskStopAllTip'] },
  pageScripts: { area: 'files', guide: 'html-pages-and-diagrams', tips: ['pageScriptsOffTip'] },
  markupMask: { area: 'markup', guide: 'viewing-and-marking-up-images-and-video', tips: ['toolMask'] },
  voiceSend: { area: 'voice', guide: 'voice-messages', tips: ['voiceSendTip', 'voiceSendBusyTip'] },
  cutSelect: { area: 'edit', guide: 'video-edits-nbcutjson', tips: ['cutToolSelect'] },
  cutBlade: { area: 'edit', guide: 'video-edits-nbcutjson', tips: ['cutToolBlade'] },
  cutClip: { area: 'edit', guide: 'video-edits-nbcutjson', tips: [] },
  cutSplit: { area: 'edit', guide: 'video-edits-nbcutjson', tips: ['cutSplit'] },
  cutComment: { area: 'edit', guide: 'video-edits-nbcutjson', tips: ['cutComment'] },
  cutGain: { area: 'edit', guide: 'video-edits-nbcutjson', tips: ['cutGainTip'] },
  cutPlace: { area: 'edit', guide: 'video-edits-nbcutjson', tips: [] },
  cutClipLight: { area: 'edit', guide: 'video-edits-nbcutjson', tips: ['cutClipOn', 'cutClipOff'] },
  settingsMenu: { area: 'settings', guide: 'settings', tips: ['settings'] },
  usageTotals: { area: 'settings', guide: 'usage', tips: ['usageTotalsTip'] },
  usageExtra: { area: 'settings', guide: 'usage', tips: ['usageExtraTip'] },
  usageTank: { area: 'settings', guide: 'usage', tips: ['usageTankTip'] },
  usageTank5h: { area: 'settings', guide: 'usage', tips: ['usageTank5hTip'] },
  projectRail: { area: 'projects', guide: 'projects-switching-opening-creating', tips: ['defRailHint'] },
  sounds: { area: 'settings', guide: 'settings', tips: ['defSoundsHint'] },
  auditLog: { area: 'settings', guide: 'audit-log', tips: ['defAuditHint'] },
} as const satisfies Record<string, { area: HelpArea; guide: string; tips: readonly TKey[] }>;

export type HelpKey = keyof typeof HELP_ENTRIES;

/**
 * What an entry that depends on this computer or platform takes, filled when it is shown: `attach` the Cmd/Ctrl prefix
 * (`modKey()`); `voiceSend` the keys that interrupt and send (`${modKey()}Enter` and Cmd/Ctrl with the voice key, as the
 * Send button builds them); `auditLog` the audit folder (`prefs.auditDir` from the server).
 */
export type HelpArgs = { attach: [mod: string]; voiceSend: [force: string, forceAlt: string]; auditLog: [dir: string] };

/** One language's entries: text, or a function of its HelpArgs. */
export type HelpDict = { [K in HelpKey]: K extends keyof HelpArgs ? (...args: HelpArgs[K]) => string : string };

export const HELP: Record<UiLang, HelpDict> = { en: helpEn, ru: helpRu, 'zh-CN': helpZhCN, es: helpEs, 'pt-BR': helpPtBR, de: helpDe };
