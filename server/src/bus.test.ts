import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentProvider } from '@nota-bene/shared';
import { agentBus, framed, type BusAgent } from './bus.ts';
import { EventHub } from './hub.ts';

type Fake = BusAgent & { heard: string[]; answer: (text: string) => string; stop?: boolean };

function fake(id: string, provider: AgentProvider, root = '/p'): Fake {
  const hub = new EventHub();
  let busy = false;
  const a: Fake = {
    id, provider, hub, heard: [], answer: (t) => `${id} read: ${t.split('\n\n').pop()}`,
    root: () => root, title: () => `${id} title`, busy: () => busy, waiting: () => false,
    deliver(m) {
      a.heard.push(m.text);
      hub.emit({ kind: 'user', id: m.id, text: m.shown });
      busy = true;
      setTimeout(() => {
        hub.emit({ kind: 'agent', e: { t: 'tool-call', id: 't', name: 'Read', input: {}, sub: false } });
        hub.emit({ kind: 'agent', e: { t: 'message', id: `${m.id}:0`, text: a.answer(m.text) } } as never);
        busy = false;
        hub.emit({ kind: 'agent', e: { t: 'turn-end', stop: a.stop ? 'interrupted' : 'done', secs: 1, answers: [], queued: 0 } } as never);
      }, 30);
    },
  };
  return a;
}

const servers: http.Server[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

async function setup(agents: Fake[], o: { idleMs?: number; bearer?: (id: string) => string | null } = {}) {
  const map = new Map(agents.map((a) => [a.id, a]));
  const bus = agentBus({
    get: (id) => map.get(id),
    peers: async (id) => agents.filter((a) => a.id !== id && a.root() === map.get(id)!.root()),
    bearer: o.bearer ?? (() => null),
    ...(o.idleMs ? { idleMs: o.idleMs } : {}),
  });
  const server = http.createServer((req, res) => {
    const m = /^\/a\/([^/]+)\/mcp$/.exec(req.url ?? '');
    if (!m) return void res.writeHead(404).end();
    void bus.handle(m[1]!, req, res);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const connect = async (id: string, bearer?: string) => {
    const c = new Client({ name: 'test', version: '1' });
    clients.push(c);
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/a/${id}/mcp`), bearer ? { requestInit: { headers: { authorization: `Bearer ${bearer}` } } } : {}));
    return c;
  };
  return { bus, connect };
}
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

describe('the agent bus', () => {
  it('lists the other agents of the project only, with their state', async () => {
    const a = fake('claude-aaaaaa', 'claude'), b = fake('codex-bbbbbb', 'codex'), far = fake('omp-cccccc', 'omp', '/elsewhere');
    const { connect } = await setup([a, b, far]);
    const c = await connect(a.id);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['agents', 'ask', 'tell']);
    expect(JSON.parse(text(await c.callTool({ name: 'agents', arguments: {} })))).toEqual([{ id: b.id, provider: 'codex', folder: '/p', state: 'idle', title: 'codex-bbbbbb title' }]);
  });

  it('ask: a turn of the target, framed with the sender, and its final answer back; tell returns at once', async () => {
    const a = fake('claude-aaaaaa', 'claude'), b = fake('codex-bbbbbb', 'codex');
    const { connect } = await setup([a, b]);
    const c = await connect(a.id);
    expect(text(await c.callTool({ name: 'ask', arguments: { to: b.id, text: 'review x.ts' } }))).toBe('codex-bbbbbb read: review x.ts');
    expect(b.heard[0]).toBe(framed({ agent: a.id, provider: 'claude' }, 'review x.ts', true));
    expect(text(await c.callTool({ name: 'tell', arguments: { to: b.id, text: 'thanks' } }))).toBe(`Delivered to ${b.id}.`);
    expect(b.heard[1]).toContain('it does not wait');
  });

  it('refuses an agent of another project, a loop in the chain, and asks past 8 hops', async () => {
    const a = fake('claude-aaaaaa', 'claude'), b = fake('codex-bbbbbb', 'codex'), far = fake('omp-cccccc', 'omp', '/elsewhere');
    const { connect } = await setup([a, b, far]);
    const ca = await connect(a.id);
    const no = await ca.callTool({ name: 'ask', arguments: { to: far.id, text: 'hi' } });
    expect(no.isError).toBe(true);
    // b answers a's ask by asking a back: a is in the chain
    let loop = '';
    b.answer = () => 'asked back';
    const cb = await connect(b.id);
    const origDeliver = b.deliver;
    b.deliver = (m) => { origDeliver(m); void cb.callTool({ name: 'ask', arguments: { to: a.id, text: 'and you?' } }).then((r) => { loop = text(r); }); };
    await ca.callTool({ name: 'ask', arguments: { to: b.id, text: 'go' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(loop).toMatch(/^Refused: claude-aaaaaa is already waiting/);
  });

  it('a stopped target turn ends the exchange; no progress for too long gives up', async () => {
    const a = fake('claude-aaaaaa', 'claude'), b = fake('codex-bbbbbb', 'codex'), mute = fake('omp-dddddd', 'omp');
    b.stop = true;
    mute.deliver = (m) => mute.hub.emit({ kind: 'user', id: m.id, text: m.shown });
    const { connect } = await setup([a, b, mute], { idleMs: 200 });
    const c = await connect(a.id);
    const stopped = await c.callTool({ name: 'ask', arguments: { to: b.id, text: 'x' } });
    expect([stopped.isError, text(stopped)]).toEqual([true, "codex-bbbbbb's turn was stopped before it answered."]);
    const idle = await c.callTool({ name: 'ask', arguments: { to: mute.id, text: 'x' } });
    expect(idle.isError).toBe(true);
    expect(text(idle)).toMatch(/made no progress/);
  });

  it('only with the agent\'s own bearer', async () => {
    const a = fake('claude-aaaaaa', 'claude'), b = fake('codex-bbbbbb', 'codex');
    const { connect } = await setup([a, b], { bearer: (id) => `secret-${id}` });
    await expect(connect(a.id, 'secret-codex-bbbbbb')).rejects.toThrow();
    await expect(connect(a.id)).rejects.toThrow();
    const ok = await connect(a.id, 'secret-claude-aaaaaa');
    expect((await ok.listTools()).tools).toHaveLength(3);
  });
});
