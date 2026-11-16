// A server restart (exit 75) that waits for a pause (gh-422), on the update's pause rule: `busy` in server.ts (a turn,
// a waiting question or approval, a switch, a `! cmd` run, a task of the agent). With no page open the server
// restarts by itself at the next pause; with one open the page asks (`/restart-server/pause`) once its own side is
// quiet too, as it asks for the update's hand-over.

/** Exit code for the user's restart: the launcher relaunches at once with `--continue`. */
export const RESTART = 75;
/** restart answers first; the exit follows once the reply is out (replied()), or after this long when that never comes. */
const REPLY_LIMIT_MS = 2_000;
/** while a restart is pending and no page is open, the server looks for a pause this often */
const PENDING_EVERY_MS = 1_000;

/**
 * The exit that follows an accepted ask in a pause: `accept()` says yes only in a pause (and once), the exit waits for
 * the reply (`replied()`, or REPLY_LIMIT_MS) and checks the pause again then: a send that came meanwhile is not cut off.
 * `exit` may still decline (it re-checks its own conditions).
 */
export function pauseExit(o: { busy: () => boolean; exit: () => void; limitMs?: number; /** the pause ended before the reply was out: no exit */ declined?: () => void }) {
  let accepted: NodeJS.Timeout | null = null;
  function replied(): void {
    if (!accepted) return;
    clearTimeout(accepted);
    accepted = null;
    if (!o.busy()) o.exit();
    else o.declined?.();
  }
  return {
    accept(): boolean {
      if (o.busy() || accepted) return false;
      accepted = setTimeout(replied, o.limitMs ?? REPLY_LIMIT_MS);
      accepted.unref();
      return true;
    },
    replied,
    stop(): void {
      if (accepted) clearTimeout(accepted);
      accepted = null;
    },
  };
}

export type RestartGate = {
  pending(): boolean;
  /** 'now': nothing to wait for, the caller exits once its reply is out; 'pending': the exit waits for the next pause */
  request(): 'now' | 'pending';
  /** the page's ask in its pause: 'ok' (the exit follows replied()), 'busy', or 'none' (nothing pending) */
  pause(): 'ok' | 'busy' | 'none';
  replied(): void;
  /** false when nothing was pending */
  cancel(): boolean;
  stop(): void;
};

export function restartGate(o: {
  busy: () => boolean;
  tabs: () => number;
  exit: (code: number) => void;
  /** the pending state changed (the server tells every page) */
  changed: (pending: boolean) => void;
  everyMs?: number;
}): RestartGate {
  let pending = false;
  let timer: NodeJS.Timeout | null = null;
  const clear = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const go = () => {
    if (!pending) return;
    pending = false;
    clear();
    o.exit(RESTART);
  };
  // declined at the reply: still pending, said again so the page that asked leaves its restarting state and waits
  const ask = pauseExit({ busy: o.busy, exit: go, declined: () => { if (pending) o.changed(true); } });
  return {
    pending: () => pending,
    request() {
      if (pending) return 'pending';
      if (!o.busy()) return 'now';
      pending = true;
      o.changed(true);
      timer = setInterval(() => { if (o.tabs() === 0 && !o.busy()) go(); }, o.everyMs ?? PENDING_EVERY_MS);
      timer.unref();
      return 'pending';
    },
    pause() {
      if (!pending) return 'none';
      return ask.accept() ? 'ok' : 'busy';
    },
    replied: () => ask.replied(),
    cancel() {
      if (!pending) return false;
      pending = false;
      clear();
      ask.stop();
      o.changed(false);
      return true;
    },
    stop() {
      clear();
      ask.stop();
    },
  };
}
