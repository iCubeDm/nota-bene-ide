// Tests only: most tests ask one agent's routes, which live under /a/<id>/ (issue 639: the top is the server's home).
import { verifiedBearer } from './auth.ts';
import { startServer } from './server.ts';

/** `startServer`, its `url` the launch agent's (`http://127.0.0.1:<port>/a/<id>`); `server`: the top's. */
export async function agentServer(o: Parameters<typeof startServer>[0]): Promise<Awaited<ReturnType<typeof startServer>> & { server: string; agent: string }> {
  const s = await startServer(o);
  const bearer = o.insecureNoAuth ? null : await verifiedBearer(Number(new URL(s.url).port), 2000);
  const info = (await (await fetch(`${s.url}/info`, bearer ? { headers: { authorization: bearer } } : {})).json()) as { agents?: { id: string }[] };
  const agent = info.agents?.[0]?.id;
  if (!agent) throw new Error('no agent in /info');
  return { ...s, url: `${s.url}/a/${agent}`, server: s.url, agent };
}
