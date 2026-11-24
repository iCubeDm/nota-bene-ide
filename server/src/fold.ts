// A window beside the running server (epic 383, step 2c): alone in its server, idle and with no tab, it hands its folder to the
// running server below it (lower port) and ends; its session continues there as an agent. A window started with --port
// stays a server of its own (the launcher does not ask for this then). Only a server below is asked, so two such windows
// never hand to each other: they fold into the lowest one.
import type { AgentProvider } from './agent/provider.ts';
import type { AttachAsk, Attached } from './attach.ts';

/** What this window has: its folder, provider and session (none before the first turn). */
export type FoldWhat = { root: string; provider: AgentProvider; session?: string };

export type FoldOptions = {
  port: number;
  everyMs: number;
  /** its only agent, no tab on it and nothing under way (a turn, a question, a pending restart) */
  quiet: () => boolean;
  what: () => FoldWhat;
  attach: (ask: AttachAsk & { under: number }) => Promise<Attached | null>;
  /** ends the window as Stop does (the launcher unregisters it) */
  stop: () => void;
};

/**
 * Looks every `everyMs`; quiet twice in a row hands over. A window with no session id yet stays (the unsent set of a new
 * session lives only in its memory). Once the server below took the folder the window ends, even if a tab came meanwhile:
 * the session is there now, and the server below answers a retry with the agent it opened. Returns the stop of the looking.
 */
export function startFold(o: FoldOptions): () => void {
  let quietLooks = 0;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    quietLooks = o.quiet() ? quietLooks + 1 : 0;
    if (quietLooks < 2) return;
    // asked only when quiet (issue 657): `what` reads the server's only agent
    const w = o.what();
    if (!w.session) return;
    busy = true;
    o.attach({ root: w.root, provider: w.provider, mode: 'resume', session: w.session, show: false, under: o.port })
      .catch(() => null) // a refusal (the folder, the session): tried again later, maybe by another server
      .then((hit) => {
        busy = false;
        if (!hit) return; // none below yet
        clearInterval(timer);
        o.stop();
      });
  }, o.everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
