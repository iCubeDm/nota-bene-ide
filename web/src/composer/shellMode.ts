import { has, SHELL_CMD_MAX } from '@nota-bene/shared';
import { t, toast, byteSize, activate, selectConn, sendWaiting, type AppThunk, type RootState } from '@/sdk';
import { selectDraft, selectImages, setDraft, shellDraftSent } from './slice.ts';


/**
 * A draft that is a shell command (as in Claude Code's terminal): one line that starts with `!` at offset 0 (not `![`, a
 * markdown link or image), and the server knows `shell-run`. A pasted script of several lines is a message: it must not run on one Enter.
 */
export const isShellDraft = (draft: string): boolean => draft.startsWith('!') && !draft.startsWith('![') && !draft.trimEnd().includes('\n'); // a paste's trailing newline is still one line
export const selectShellMode = (s: RootState): boolean => has(s.controls.protocol, 'shellRun') && isShellDraft(selectDraft(s));

/** The id of the `! cmd` run in progress, if the feed shows one. */
export const selectShellRunning = (s: RootState): string | null => {
  const it = s.feed.items.find((x) => x.kind === 'shell' && x.running);
  return it?.kind === 'shell' ? it.id : null;
};

/** The command of a shell draft: what follows the `!`, trimmed. */
export const commandOf = (draft: string): string => draft.slice(1).trim();

/**
 * Enter on a shell draft. 'blocked' keeps the draft (comments or images waiting, a command still running, one too long);
 * 'empty' is a bare `!`; 'offline' sends nothing; 'sent' clears the draft and shows the chat, where the block appears.
 * Never a message to the agent: the server runs it, and the agent hears of it with the next message.
 */
export const runShellDraft = (): AppThunk<'sent' | 'blocked' | 'empty' | 'offline'> => (d, getState, { connections, registry }) => {
  const st = getState();
  const draft = selectDraft(st);
  const cmd = commandOf(draft);
  if (sendWaiting(registry, st) || selectImages(st).length) return (toast(t('shellWithAttachments'), ''), 'blocked');
  if (!cmd) return 'empty';
  if (new TextEncoder().encode(cmd).length > SHELL_CMD_MAX) return (toast(t('shellTooLong', byteSize(SHELL_CMD_MAX)), ''), 'blocked');
  if (selectShellRunning(st)) return (toast(t('shellBusy'), ''), 'blocked');
  const id = crypto.randomUUID();
  if (selectConn(st) !== 'open' || !connections.current().send({ type: 'shell-run', id, cmd })) return 'offline';
  d(shellDraftSent({ id, draft })); // until the server's shell-start: a refusal puts it back
  d(setDraft(''));
  d(activate('chat'));
  return 'sent';
};

/** false: the stop did not go out (offline). */
export const stopShell = (id: string): AppThunk<boolean> => (_d, _g, { connections }) => connections.current().send({ type: 'shell-stop', id });
