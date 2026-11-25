// The windows the connector can reach: every provider's registry (`windows/` in its state dir), each entry proved with
// that provider's token (GET /hello) before anything is sent to it, and the helper bearer derived for its launch.
// Registry entries are only hints, and the connector never edits them (that stays with the launcher and liveWindows).
// It never creates a token either: a provider without one has no windows.
import { EventEmitter } from 'node:events';
import { PROVIDERS, providerStateDir, type AgentProvider } from '../agent/provider.ts';
import { helperCredential, proveListener } from '../auth.ts';
import { providerToken, registries } from '../servers.ts';
import { stateBaseDir } from '../state.ts';
import { pidAlive } from '../windows.ts';

/** A listed window the host proved (its /hello) and can reach: the bearer for its launch. Never sent to a phone. */
export type ProvedWindow = { port: number; provider: AgentProvider; root: string; bearer: string; nonce: string };

const PROVE_MS = 1000;

const same = (a: ProvedWindow, b: ProvedWindow) => a.port === b.port && a.provider === b.provider && a.nonce === b.nonce && a.root === b.root;

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
      token = providerToken(providerStateDir(stateBaseDir(), old.provider));
    } catch { /* reported by the poll */ }
    const w = token ? await this.#prove(old.port, old.provider, old.root, token) : undefined;
    const next = new Map(this.#list);
    if (w) next.set(port, w);
    else next.delete(port);
    this.#set(next);
    return w;
  }

  async #prove(port: number, provider: AgentProvider, root: string, token: string): Promise<ProvedWindow | undefined> {
    const nonce = await proveListener({ dial: port, timeoutMs: PROVE_MS, token, ...(this.#fetchFn ? { fetchFn: this.#fetchFn } : {}) });
    return nonce === null ? undefined : { port, provider, root, nonce, bearer: `Bearer ${helperCredential(token, port, nonce)}` };
  }

  async #poll(): Promise<void> {
    const found: ProvedWindow[] = [];
    await Promise.all(registries((e) => this.emit('warn', e.message)).map(async ({ provider, token, entries }) => {
      const proved = await Promise.all(entries.filter(([, w]) => pidAlive(w.pid)).map(([port, w]) => this.#prove(port, provider, w.root, token)));
      for (const w of proved) if (w) found.push(w);
    }));
    const next = new Map<number, ProvedWindow>();
    for (const w of found.sort((a, b) => PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider))) if (!next.has(w.port)) next.set(w.port, w);
    this.#set(next);
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
