// The launcher's way into a running server (epic 383, step 2c): a folder opens as an agent of a server that is already up,
// through its POST /control/open, instead of as a window of its own.
//
// Every provider's registry is looked at (a server keeps the token of the provider it started as), each live entry proved
// with that provider's token before its control token is sent, as the switcher does (projects.ts). A server of an older
// version has no /control/open (404) and is passed over. The answer's URL carries the login of that server's launch; the
// caller opens it or prints it to the one that asked (never to a log).
import path from 'node:path';
import type { AgentProvider } from './agent/provider.ts';
import { loginCredential, proveListener, readSecret, SecretError } from './auth.ts';
import { registries } from './servers.ts';
import { AGENT_ID } from './state.ts';
import { CONTROL_HEADER } from './system.ts';
import { pidAlive } from './windows.ts';

const PROVE_MS = 1500;
const OPEN_MS = 60_000; // a backend's first start (Codex app-server, an ACP agent) may take a while

/** `shown`: a tab of that server shows the agent now (it was there, or moved to it): no browser to open */
export type Attached = { port: number; agent: string; opened: boolean; shown: boolean; url: string };
/**
 * `port`: only the server there is asked (the launcher's own window of the folder); `under`: only those below that port (a
 * window folding in, fold.ts); `show: false`: no tab moves to it
 */
export type AttachAsk = { root: string; provider: AgentProvider; mode: 'resume' | 'new'; session?: string; fork?: boolean; port?: number; under?: number; show?: boolean };

/** The running servers to try, by port: every provider's live entries with that provider's tokens. */
function servers(): { port: number; token: string; control: string }[] {
  const out: { port: number; token: string; control: string }[] = [];
  for (const { dir, token, entries } of registries()) {
    let control: string | null;
    try {
      control = readSecret(path.join(dir, 'control-token'));
    } catch (e) {
      if (e instanceof SecretError) continue; // that provider's windows are the launcher's to report on, not ours
      throw e;
    }
    if (!control) continue;
    for (const [port, w] of entries) if (pidAlive(w.pid)) out.push({ port, token, control });
  }
  return out.sort((a, b) => a.port - b.port);
}

/**
 * The agent of `ask.root` in the first running server that opens agents: the one it has for that folder and provider, or
 * a new one. null: no such server. Throws when a server refuses the ask itself (400: a bad folder or session).
 */
export async function attachAgent(ask: AttachAsk, fetchFn: typeof fetch = fetch): Promise<Attached | null> {
  for (const s of servers().filter((x) => (ask.port === undefined || x.port === ask.port) && (ask.under === undefined || x.port < ask.under))) {
    const n = await proveListener({ dial: s.port, timeoutMs: PROVE_MS, token: s.token, fetchFn });
    if (n === null) continue;
    let r: Response;
    try {
      // redirect: 'error': a 307/308 would carry the token on to wherever it points
      r = await fetchFn(`http://127.0.0.1:${s.port}/control/open`, {
        method: 'POST', headers: { [CONTROL_HEADER]: s.control, 'content-type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ root: ask.root, provider: ask.provider, mode: ask.mode, ...(ask.show === false ? { show: false } : {}), ...(ask.session ? { session: ask.session, fork: ask.fork === true } : {}) }),
        signal: AbortSignal.timeout(OPEN_MS),
      });
    } catch {
      continue;
    }
    if (r.status === 400) throw new Error(await r.text());
    if (!r.ok) continue; // 404: an older server; 501: one that opens no other agents; 503: still starting
    const j = (await r.json().catch(() => null)) as { agent?: unknown; opened?: unknown; shown?: unknown } | null;
    if (typeof j?.agent !== 'string' || !AGENT_ID.test(j.agent)) continue;
    return { port: s.port, agent: j.agent, opened: j.opened === true, shown: j.shown === true, url: `http://127.0.0.1:${s.port}/a/${j.agent}/#t=${loginCredential(s.token, s.port, n)}` };
  }
  return null;
}
