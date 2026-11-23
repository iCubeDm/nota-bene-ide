// The agent bus (epic 383 2f, spec M8): the agents of one project reach each other through an MCP server the Nota Bene
// server hosts at `/a/<id>/mcp` (Streamable HTTP, loopback only; the remote channel never forwards it). Each agent's
// session is started with it and a bearer of its own, so the server knows who calls. `agents` lists the others of the
// project, `ask` delivers a message as a turn of the target and returns that turn's final answer, `tell` delivers and
// returns at once. A message is a visible turn: the target's feed shows it with its sender, the caller's shows the call.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentProvider, ServerEvent } from '@nota-bene/shared';
import type { EventHub } from './hub.ts';

/** at most this many agents in a chain of asks (A asks B asks C ...) */
export const MAX_HOPS = 8;
/** `ask` gives up after this long with no event of the target's turn */
export const ASK_IDLE_MS = 30 * 60_000;
/** how often a delivery waiting for a busy target looks again */
const WAIT_EVERY_MS = 500;

export type BusAgent = {
  id: string;
  provider: AgentProvider;
  root(): string;
  title(): string | null;
  hub: EventHub;
  /** a turn, a question or a task: a message waits for its pause */
  busy(): boolean;
  /** waits for the person (a permission or a question) */
  waiting(): boolean;
  /** the message as a send of the person's, marked with its sender; `text` is what the agent hears */
  deliver(m: { id: string; shown: string; text: string; from: { agent: string; provider: AgentProvider } }): void;
};

type Text = { type: 'text'; text: string };
const answer = (text: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text } satisfies Text], ...(isError ? { isError: true } : {}) });

const TOOLS = [
  {
    name: 'agents',
    description: 'The other agents of this project in Nota Bene (other sessions, other providers, other worktrees of the repository): id, provider, folder, state and title. Use an id with ask or tell.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ask',
    description: 'Sends a message to another agent of this project as a turn of its own and waits for that turn to end; returns its final answer. The person sees both sides. Long work is fine: the wait ends only after 30 minutes with no progress.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', description: 'the agent id (from agents)' }, text: { type: 'string', description: 'the message' } }, required: ['to', 'text'], additionalProperties: false },
  },
  {
    name: 'tell',
    description: 'Sends a message to another agent of this project as a turn of its own and returns at once. A reply, if any, comes later as a message from it.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'], additionalProperties: false },
  },
];

const PROVIDER = { claude: 'Claude', codex: 'Codex', omp: 'omp' } as const;

/** What the target hears: who sends it, whether they wait, then the message. */
export function framed(from: { agent: string; provider: AgentProvider }, text: string, waits: boolean): string {
  const how = waits
    ? 'it waits for your reply: your final answer in this turn is what it gets'
    : 'it does not wait; to answer, use the tell tool of the nota-bene MCP server';
  return `[Message from agent ${from.agent} (${PROVIDER[from.provider]}) of this project, through Nota Bene; ${how}]\n\n${text}`;
}

export function agentBus(o: {
  get(id: string): BusAgent | undefined;
  /** the other agents of `id`'s project */
  peers(id: string): Promise<BusAgent[]>;
  /** the bearer the agent `id` calls with; null: no check (a server without an access token) */
  bearer(id: string): string | null;
  idleMs?: number;
}) {
  /** the chain of the message an agent's current turn answers: who asked whom, outermost first */
  const chains = new Map<string, string[]>();

  /** waits for the target's pause (a message runs after its current turn), unless the call is given up */
  async function pause(to: BusAgent, signal: AbortSignal): Promise<void> {
    while (to.busy()) {
      if (signal.aborted) throw new Error('the call was stopped');
      await new Promise((r) => setTimeout(r, WAIT_EVERY_MS));
    }
  }

  async function send(from: BusAgent, toId: string, text: string, waits: boolean, signal: AbortSignal, progress: (step: string) => void): Promise<CallToolResult> {
    const peers = await o.peers(from.id);
    const to = peers.find((p) => p.id === toId);
    if (!to) return answer(`No agent ${toId} in this project. The agents tool lists them.`, true);
    const chain = [...(chains.get(from.id) ?? []), from.id];
    if (chain.includes(to.id)) return answer(`Refused: ${to.id} is already waiting in this chain of messages (${chain.join(' → ')}); asking it would never end.`, true);
    if (chain.length >= MAX_HOPS) return answer(`Refused: a chain of messages may pass ${MAX_HOPS} agents at most (${chain.join(' → ')}).`, true);
    await pause(to, signal);
    const id = randomUUID();
    const sender = { agent: from.id, provider: from.provider };
    const done = waits ? reply(to, id, signal, progress) : null;
    chains.set(to.id, chain);
    to.deliver({ id, shown: text, text: framed(sender, text, waits), from: sender });
    if (!done) return answer(`Delivered to ${to.id}.`);
    return done;
  }

  /** the final answer of the turn the message `id` starts, or why there is none */
  function reply(to: BusAgent, id: string, signal: AbortSignal, progress: (step: string) => void): Promise<CallToolResult> {
    return new Promise((resolve) => {
      let started = false;
      let last = '';
      let timer: NodeJS.Timeout;
      const finish = (r: CallToolResult) => {
        clearTimeout(timer);
        off();
        signal.removeEventListener('abort', stop);
        resolve(r);
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(answer(`${to.id} made no progress for ${Math.round((o.idleMs ?? ASK_IDLE_MS) / 60_000)} minutes; no answer.`, true)), o.idleMs ?? ASK_IDLE_MS);
        timer.unref();
      };
      const stop = () => finish(answer('The call was stopped.', true));
      const off = to.hub.tap((ev: ServerEvent) => {
        if (ev.kind === 'user' && ev.id === id) started = true;
        if (!started || ev.kind !== 'agent') return;
        arm();
        const e = ev.e;
        if (e.t === 'message') last = e.text;
        else if (e.t === 'tool-call' && !e.sub) progress(`${to.id}: ${e.name}`);
        else if (e.t === 'turn-end') {
          if (e.stop === 'interrupted') finish(answer(`${to.id}'s turn was stopped before it answered.`, true));
          else if (e.stop !== 'done') finish(answer(`${to.id}'s turn ended without an answer (${e.stop}).`, true));
          else finish(answer(last || '(no text)'));
        }
      });
      signal.addEventListener('abort', stop);
      arm();
    });
  }

  function authorized(id: string, req: http.IncomingMessage): boolean {
    const want = o.bearer(id);
    if (want === null) return true;
    const got = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
  }

  return {
    /** a person's message to the agent starts a chain of its own */
    personSent(id: string): void {
      chains.delete(id);
    },
    forget(id: string): void {
      chains.delete(id);
    },
    /** POST (and GET/DELETE, which a stateless server refuses) `/a/<id>/mcp` of the agent `id` */
    async handle(id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      const from = o.get(id);
      if (!from || !authorized(id, req)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        return void res.end('unauthorized');
      }
      const server = new Server({ name: 'nota-bene', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
      server.setRequestHandler(CallToolRequestSchema, async (r, extra) => {
        const args = (r.params.arguments ?? {}) as { to?: unknown; text?: unknown };
        if (r.params.name === 'agents') {
          const peers = await o.peers(id);
          return answer(JSON.stringify(peers.map((p) => ({
            id: p.id, provider: p.provider, folder: p.root(), state: p.waiting() ? 'waiting' : p.busy() ? 'working' : 'idle', title: p.title(),
          })), null, 2));
        }
        if (r.params.name !== 'ask' && r.params.name !== 'tell') return answer(`No tool ${r.params.name}.`, true);
        if (typeof args.to !== 'string' || typeof args.text !== 'string' || !args.text.trim()) return answer('to and text are required.', true);
        const token = r.params._meta?.progressToken;
        let n = 0;
        const progress = (step: string) => {
          if (token === undefined) return;
          void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: step } }).catch(() => {});
        };
        return send(from, args.to, args.text, r.params.name === 'ask', extra.signal, progress);
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    },
  };
}
