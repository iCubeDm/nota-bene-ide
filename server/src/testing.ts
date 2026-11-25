// Tests only: most tests ask one agent's routes, which live under /a/<id>/ (issue 639: the top is the server's home).
import type { ProviderBackend as AgentBackend } from './agent/types.ts';
import { verifiedBearer } from './auth.ts';
import { startServer } from './server.ts';
import { agentPath } from './state.ts';

type Options = Parameters<typeof startServer>[0];

/** `startServer` with a `backend`: the launch agent's own, where a test tells it from the ones `backends` makes. */
export function launchServer(o: Omit<Options, 'backends'> & ({ backend: AgentBackend; backends?: Options['backends'] } | { backends: Options['backends'] })): ReturnType<typeof startServer> {
  let first = 'backend' in o ? o.backend : undefined;
  const { backend: _, ...rest } = o as typeof o & { backend?: AgentBackend };
  return startServer({ ...rest, backends: (p) => {
    const b = first ?? o.backends!(p);
    first = undefined;
    return b;
  } });
}

/** `launchServer`, its `url` the launch agent's (`http://127.0.0.1:<port>/a/<id>`); `server`: the top's. */
export async function agentServer(o: Parameters<typeof launchServer>[0]): Promise<Awaited<ReturnType<typeof startServer>> & { server: string; agent: string }> {
  const s = await launchServer(o);
  const bearer = o.insecureNoAuth ? null : await verifiedBearer(Number(new URL(s.url).port), 2000);
  const info = (await (await fetch(`${s.url}/info`, bearer ? { headers: { authorization: bearer } } : {})).json()) as { agents?: { id: string }[] };
  const agent = info.agents?.[0]?.id;
  if (!agent) throw new Error('no agent in /info');
  return { ...s, url: `${s.url}${agentPath(agent)}`, server: s.url, agent };
}
