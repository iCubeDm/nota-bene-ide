import fs from 'node:fs';
import path from 'node:path';
import { readPrefs } from './prefs.ts';
import { installing, installRelease, patchUpdateState, readCurrent, readUpdateState, runtimeDir } from './runtime.ts';
import { CHECK_EVERY_MS, isNewer, RELEASE, updateCheckForcedOff } from './update.ts';

/** Exit code for "a newer version is current": the launcher hands the window over to it (only with NOTA_BENE_HANDOVER=1). */
export const HANDOVER = 77;
/** While a newer version waits, the window looks for a pause this often. */
const READY_EVERY_MS = 30_000;
/** restart() answers first; the exit follows once the reply is out. */
const REPLY_GRACE_MS = 200;

export type UpdatePhase = 'none' | 'available' | 'installing' | 'ready' | 'failed' | 'rolled-back';
export type UpdateStatus = {
  current: string;
  latest: string | null;
  phase: UpdatePhase;
  canUpdate: boolean;
  auto: boolean;
  busy: boolean;
  /** the path of update.log */
  log: string;
  failed?: string;
  rolledBack?: string;
  updatedFrom?: string;
};
export type Updater = {
  status(): Promise<UpdateStatus>;
  install(): Promise<UpdateStatus>;
  restart(): 'ok' | 'busy' | 'not-ready';
  setAuto(on: boolean): void;
  stop(): void;
};

const checkOn = () => !updateCheckForcedOff() && readPrefs().updateCheck !== false;

/**
 * One window's part of the in-app update: it notices a newer release, installs it (by hand, or by itself with
 * `auto`), and, once `current` is newer than this window, exits with HANDOVER in a pause so its launcher restarts it there.
 * `canUpdate` is the launcher's say (NOTA_BENE_HANDOVER); a source checkout or the check being off also forbids it, and
 * then nothing ticks, installs or exits. `fromRuntime`: this server runs from inside the runtime folder (a handed-over
 * window), the only kind that may go back to an older `current` after a rollback.
 */
export function updater(o: {
  version: string | (() => Promise<string>);
  canUpdate: boolean;
  busy: () => boolean;
  tabs: () => number;
  exit: (code: number) => void;
  newer: (current: string) => Promise<string | null>;
  install?: typeof installRelease;
  everyMs?: number;
  fromRuntime?: boolean;
  updatedFrom?: string;
}): Updater {
  const install = o.install ?? installRelease;
  let own: Promise<string> | null = null;
  const version = () => (own ??= Promise.resolve(typeof o.version === 'string' ? o.version : o.version()));
  let running: Promise<unknown> | null = null; // this window's own install
  let exiting = false;

  const allowed = (v: string) => o.canUpdate && RELEASE.test(v) && checkOn();

  // a newer `current` than this window (never the rolled-back one: the launcher refuses it), or, in a handed-over
  // window on a rolled-back release, the older `current` it falls back to
  function ready(v: string): boolean {
    if (!allowed(v)) return false;
    const cur = readCurrent();
    if (!cur || cur === v) return false;
    const rb = readUpdateState().rolledBack?.version;
    if (isNewer(cur, v)) return cur !== rb;
    return !!o.fromRuntime && rb === v;
  }

  async function status(): Promise<UpdateStatus> {
    const v = await version();
    const ok = allowed(v);
    const latest = await o.newer(v);
    const st = readUpdateState();
    let phase: UpdatePhase = latest ? 'available' : 'none';
    if (ok) {
      if (running || installing()) phase = 'installing';
      else if (ready(v)) phase = 'ready';
      else if (latest && st.failed?.version === latest) phase = 'failed';
      else if (latest && st.rolledBack?.version === latest) phase = 'rolled-back';
    }
    return {
      current: v, latest, phase, canUpdate: ok, auto: st.auto, busy: o.busy(), log: path.join(runtimeDir(), 'update.log'),
      ...(ok && st.failed && st.failed.version === latest ? { failed: st.failed.reason } : {}),
      ...(ok && st.rolledBack ? { rolledBack: st.rolledBack.version } : {}),
      ...(o.updatedFrom && RELEASE.test(o.updatedFrom) && RELEASE.test(v) && isNewer(v, o.updatedFrom) ? { updatedFrom: o.updatedFrom } : {}),
    };
  }

  // starts the install of the newest release seen; the status says `installing` meanwhile
  function start(latest: string): void {
    running = install(latest).catch(() => undefined).finally(() => { running = null; });
  }

  async function doInstall(): Promise<UpdateStatus> {
    const v = await version();
    if (allowed(v) && !running && !installing()) {
      const latest = await o.newer(v);
      if (latest && isNewer(latest, v) && !running) start(latest);
    }
    return status();
  }

  async function tick(): Promise<void> {
    const v = await version();
    if (!allowed(v)) return;
    handover(v);
    const st = readUpdateState();
    if (!st.auto || running || installing()) return;
    const latest = await o.newer(v);
    if (!latest || !isNewer(latest, v) || latest === readCurrent()) return;
    if (latest === st.rolledBack?.version || latest === st.failed?.version) return; // by hand only, once it went wrong
    if (!running) start(latest);
  }

  function handover(v: string): void {
    if (exiting || !ready(v) || o.tabs() > 0 || o.busy()) return;
    exiting = true;
    o.exit(HANDOVER);
  }

  const timers: NodeJS.Timeout[] = [];
  if (o.canUpdate) {
    const guard = (f: () => unknown) => () => { try { void Promise.resolve(f()).catch(() => undefined); } catch { /* the next tick tries again */ } };
    timers.push(setInterval(guard(tick), o.everyMs ?? CHECK_EVERY_MS));
    timers.push(setInterval(guard(async () => handover(await version())), READY_EVERY_MS));
    for (const t of timers) t.unref();
  }

  let ownVersion: string | null = typeof o.version === 'string' ? o.version : null;
  void version().then((v) => { ownVersion = v; });

  return {
    status,
    install: doInstall,
    restart() {
      if (o.busy()) return 'busy';
      if (ownVersion === null || exiting || !ready(ownVersion)) return 'not-ready';
      exiting = true;
      setTimeout(() => o.exit(HANDOVER), REPLY_GRACE_MS).unref();
      return 'ok';
    },
    setAuto(on) { patchUpdateState((s) => ({ ...s, auto: on })); },
    stop() { for (const t of timers) clearInterval(t); },
  };
}
