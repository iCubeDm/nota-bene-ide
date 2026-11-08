// The windows the connector can reach: every provider's registry (`windows/` in its state dir), each entry proved with
// that provider's token (GET /hello) before anything is sent to it, and the helper bearer derived for its launch.
// Registry entries are only hints, and the connector never edits them (that stays with the launcher and liveWindows).
// It never creates a token either: a provider without one has no windows.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { providerStateDir, type AgentProvider } from '../agent/provider.ts';
import { helperCredential, proveListener, readPrivateFile } from '../auth.ts';
import { stateBaseDir } from '../state.ts';
import { pidAlive, readWindows } from '../windows.ts';

export type HostWindow = { port: number; provider: AgentProvider; root: string; bearer: string; nonce: string };

const PROVIDERS: AgentProvider[] = ['claude', 'codex', 'omp'];
const TOKEN_RE = /^[0-9a-f]{64}$/;
const PROVE_MS = 1000;

function tokenOf(dir: string): string | null {
  return readPrivateFile(path.join(dir, 'token'), TOKEN_RE, 'a token (64 hex characters)', 'delete it to make a new token (every open window then has to be reopened)');
}

const same = (a: HostWindow, b: HostWindow) => a.port === b.port && a.provider === b.provider && a.nonce === b.nonce && a.root === b.root;

/** Events: `change(list)` when the set of windows or a launch changes, `warn(message)` for an unusable token file. */
export class Windows extends EventEmitter {
  #pollMs: number;
  #fetchFn: typeof fetch | undefined;
  #list = new Map<number, HostWindow>();
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

  list(): HostWindow[] {
    return [...this.#list.values()].sort((a, b) => a.port - b.port);
  }

  get(port: number): HostWindow | undefined {
    return this.#list.get(port);
  }

  refresh(): Promise<void> {
    this.#polling ??= this.#poll().finally(() => (this.#polling = undefined));
    return this.#polling;
  }

  /** A fresh /hello for one window (its bearer was refused): the new launch, or undefined and the window dropped. */
  async reprove(port: number): Promise<HostWindow | undefined> {
    const old = this.#list.get(port);
    if (!old) return undefined;
    let token: string | null = null;
    try {
      token = tokenOf(providerStateDir(stateBaseDir(), old.provider));
    } catch { /* reported by the poll */ }
    const w = token ? await this.#prove(old.port, old.provider, old.root, token) : undefined;
    const next = new Map(this.#list);
    if (w) next.set(port, w);
    else next.delete(port);
    this.#set(next);
    return w;
  }

  async #prove(port: number, provider: AgentProvider, root: string, token: string): Promise<HostWindow | undefined> {
    const nonce = await proveListener({ dial: port, timeoutMs: PROVE_MS, token, ...(this.#fetchFn ? { fetchFn: this.#fetchFn } : {}) });
    return nonce === null ? undefined : { port, provider, root, nonce, bearer: `Bearer ${helperCredential(token, port, nonce)}` };
  }

  async #poll(): Promise<void> {
    const found: HostWindow[] = [];
    await Promise.all(PROVIDERS.map(async (provider) => {
      const dir = providerStateDir(stateBaseDir(), provider);
      if (!fs.existsSync(dir)) return;
      let token: string | null;
      try {
        token = tokenOf(dir);
      } catch (e) {
        this.emit('warn', (e as Error).message);
        return;
      }
      if (!token) return;
      const entries = Object.entries(readWindows(dir)).filter(([, w]) => pidAlive(w.pid));
      const proved = await Promise.all(entries.map(([port, w]) => this.#prove(Number(port), provider, w.root, token)));
      for (const w of proved) if (w) found.push(w);
    }));
    const next = new Map<number, HostWindow>();
    for (const w of found.sort((a, b) => PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider))) if (!next.has(w.port)) next.set(w.port, w);
    this.#set(next);
  }

  #set(next: Map<number, HostWindow>): void {
    const changed = next.size !== this.#list.size || [...next.values()].some((w) => {
      const o = this.#list.get(w.port);
      return !o || !same(o, w);
    });
    this.#list = next;
    if (changed) this.emit('change', this.list());
  }
}

/** GET /info of a window with its bearer: the window's fields, or null. */
export async function windowInfo(w: HostWindow, fetchFn: typeof fetch = fetch): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetchFn(`http://127.0.0.1:${w.port}/info`, { headers: { authorization: w.bearer }, signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (!r.ok) return null;
    const j: unknown = await r.json();
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
