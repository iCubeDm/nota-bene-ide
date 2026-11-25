// The servers the connector can reach: the registry (`windows/` in the state dir), each entry proved with the token
// (GET /hello) before anything is sent to it, and the helper bearer derived for its launch.
// Registry entries are only hints, and the connector never edits them (that stays with the launcher and liveWindows).
// It never creates a token either: without one there are no servers.
import { EventEmitter } from 'node:events';
import { helperCredential, proveListener } from '../auth.ts';
import { registry, serverToken } from '../servers.ts';
import { pidAlive } from '../windows.ts';

/** A listed window the host proved (its /hello) and can reach: the bearer for its launch. Never sent to a phone. */
export type ProvedWindow = { port: number; root: string; bearer: string; nonce: string };

const PROVE_MS = 1000;

const same = (a: ProvedWindow, b: ProvedWindow) => a.port === b.port && a.nonce === b.nonce && a.root === b.root;

/** Events: `change(list)` when the set of windows or a launch changes, `warn(message)` for an unusable token file. */
export class Windows extends EventEmitter {
  #pollMs: number;
  #fetchFn: typeof fetch | undefined;
  #list = new Map<number, ProvedWindow>();
  #timer: NodeJS.Timeout | undefined;
  #polling: Promise<void> | undefined;

  constructor(o: { pollMs?: number; fetchFn?: typeof fetch } = {}) {
    super();
    this.#pollMs = o.pollMs ?? 3000;
    this.#fetchFn = o.fetchFn;
  }

  /** Resolves after the first poll. */
  async start(): Promise<void> {
    await this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.#pollMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  list(): ProvedWindow[] {
    return [...this.#list.values()].sort((a, b) => a.port - b.port);
  }

  get(port: number): ProvedWindow | undefined {
    return this.#list.get(port);
  }

  refresh(): Promise<void> {
    this.#polling ??= this.#poll().finally(() => (this.#polling = undefined));
    return this.#polling;
  }

  /** A fresh /hello for one window (its bearer was refused): the new launch, or undefined and the window dropped. */
  async reprove(port: number): Promise<ProvedWindow | undefined> {
    const old = this.#list.get(port);
    if (!old) return undefined;
    let token: string | null = null;
    try {
      token = serverToken();
    } catch { /* reported by the poll */ }
    const w = token ? await this.#prove(old.port, old.root, token) : undefined;
    const next = new Map(this.#list);
    if (w) next.set(port, w);
    else next.delete(port);
    this.#set(next);
    return w;
  }

  async #prove(port: number, root: string, token: string): Promise<ProvedWindow | undefined> {
    const nonce = await proveListener({ dial: port, timeoutMs: PROVE_MS, token, ...(this.#fetchFn ? { fetchFn: this.#fetchFn } : {}) });
    return nonce === null ? undefined : { port, root, nonce, bearer: `Bearer ${helperCredential(token, port, nonce)}` };
  }

  async #poll(): Promise<void> {
    const r = registry((e) => this.emit('warn', e.message));
    const proved = await Promise.all((r?.entries ?? []).filter(([, w]) => pidAlive(w.pid)).map(([port, w]) => this.#prove(port, w.root, r!.token)));
    this.#set(new Map(proved.flatMap((w) => (w ? [[w.port, w] as const] : []))));
  }

  #set(next: Map<number, ProvedWindow>): void {
    const changed = next.size !== this.#list.size || [...next.values()].some((w) => {
      const o = this.#list.get(w.port);
      return !o || !same(o, w);
    });
    this.#list = next;
    if (changed) this.emit('change', this.list());
  }
}
