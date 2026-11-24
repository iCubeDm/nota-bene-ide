// The agent bus (epic 383 2f, spec M8): the agents of one project reach each other through an MCP server the Nota Bene
// server hosts at `/a/<id>/mcp` (Streamable HTTP, loopback only; the remote channel never forwards it). Each agent's
// session is started with it and a bearer of its own, so the server knows who calls. `agents` lists the others of the
// project, `ask` delivers a message as a turn of the target and returns that turn's final answer, `tell` delivers and
// returns at once. A message is a visible turn: the target's feed shows it with its sender, the caller's shows the call.
// An agent may start helpers (2g, spec M9): `spawn` opens one in the project, runs the task as its first turn and returns
// its answer; it leads them, and only it talks to them first. `close` ends one.
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
/** live helpers at most, of one lead and of one project */
export const HELPERS_PER_LEAD = 4;
export const HELPERS_PER_PROJECT = 8;
/** a helper with no event of its own this long, and nothing running or on its way, folds up */
export const HELPER_IDLE_MS = 15 * 60_000;

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
  /** the agent that started it (a helper's lead), null for one the person added or kept */
  lead(): string | null;
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
    description: 'Queues a message to another agent of this project and returns at once. It starts a turn when the target is idle, without interrupting its current work. A reply, if any, comes later as a message from it.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'], additionalProperties: false },
  },
  {
    name: 'spawn',
    description: `Starts a helper: a new agent of this project (claude, codex or omp) with its own feed, which runs task as its first turn; returns its id and that turn's final answer. You lead it: talk to it with ask or tell, end it with close. At most ${HELPERS_PER_LEAD} live helpers per lead; an idle helper closes itself after 15 minutes.`,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['provider', 'task'],
      properties: {
        provider: { type: 'string', enum: ['claude', 'codex', 'omp'] },
        task: { type: 'string', description: 'its first message' },
        cwd: { type: 'string', description: 'its folder: this project\'s (the default) or another worktree of its repository' },
      },
    },
  },
  {
    name: 'close',
    description: 'Ends a helper you lead: its process and tab go, its session stays in the project\'s Sessions.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
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
  /** a helper of `lead` in `cwd` (its folder, or another worktree of the repository); throws with why not */
  spawn?(lead: BusAgent, provider: string, cwd: string): Promise<BusAgent>;
  /** ends the agent `id` */
  close?(id: string): void;
  idleMs?: number;
}) {
  /**
   * An agent's current turn, as a message started it: who waits for its answer (outermost first: asking one of them would
   * never end) and how many agents the chain has passed
   */
  const chains = new Map<string, { waiting: string[]; hops: number }>();
  const chainOf = (id: string) => chains.get(id) ?? { waiting: [], hops: 0 };
  // Accepted tells belong to the bus, not to the HTTP request that has already returned.
  const pending = new Map<string, { timer: NodeJS.Timeout; messages: (() => void)[] }>();
  function forgetPending(id: string): void {
    const q = pending.get(id);
    if (q) clearInterval(q.timer);
    pending.delete(id);
  }
  function enqueue(to: BusAgent, send: () => void): void {
    let q = pending.get(to.id);
    if (!q) {
      const messages: (() => void)[] = [];
      const timer = setInterval(() => {
        if (o.get(to.id) !== to) return forgetPending(to.id);
        if (to.busy()) return;
        messages.shift()?.();
        if (!messages.length) forgetPending(to.id);
      }, WAIT_EVERY_MS);
      timer.unref();
      q = { timer, messages };
      pending.set(to.id, q);
    }
    q.messages.push(send);
  }

  /** why `from` may not message `to` first, or null: a helper is its lead's, and a helper reaches its lead and its own */
  function unreachable(from: BusAgent, to: BusAgent): string | null {
    const asked = chainOf(from.id).waiting.includes(to.id);
    const toLead = to.lead(), fromLead = from.lead();
    if (toLead && toLead !== from.id && fromLead !== to.id && !asked) return `Refused: ${to.id} is a helper of ${toLead}; only it talks to its helpers.`;
    if (fromLead && to.id !== fromLead && toLead !== from.id && !asked) return `Refused: a helper reaches its lead (${fromLead}), its own helpers and whoever asked it.`;
    return null;
  }

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
    const why = unreachable(from, to);
    if (why) return answer(why, true);
    return deliver(from, to, text, waits, signal, progress);
  }

  /** `text` as a turn of `to`, after its pause; with `waits`, that turn's final answer */
  async function deliver(from: BusAgent, to: BusAgent, text: string, waits: boolean, signal: AbortSignal, progress: (step: string) => void): Promise<CallToolResult> {
    const mine = chainOf(from.id);
    const waiting = waits ? [...mine.waiting, from.id] : [];
    if (waits && mine.waiting.includes(to.id)) return answer(`Refused: ${to.id} is already waiting in this chain of messages (${waiting.join(' → ')}); asking it would never end.`, true);
    if (mine.hops + 1 >= MAX_HOPS) return answer(`Refused: a chain of messages may pass ${MAX_HOPS} agents at most.`, true);
    const id = randomUUID();
    const sender = { agent: from.id, provider: from.provider };
    const dispatch = () => {
      chains.set(to.id, { waiting, hops: mine.hops + 1 });
      to.deliver({ id, shown: text, text: framed(sender, text, waits), from: sender });
    };
    if (!waits && (to.busy() || pending.has(to.id))) {
      enqueue(to, dispatch);
      return answer(`Queued for ${to.id}; delivery waits for its current work to finish.`);
    }
    await pause(to, signal);
    const done = waits ? reply(to, id, signal, progress) : null;
    dispatch();
    if (!done) return answer(`Delivered to ${to.id}.`);
    return done;
  }

  async function spawn(from: BusAgent, provider: string, task: string, cwd: string | undefined, signal: AbortSignal, progress: (step: string) => void): Promise<CallToolResult> {
    if (!o.spawn) return answer('This Nota Bene starts no helpers.', true);
    const peers = await o.peers(from.id);
    if (peers.filter((p) => p.lead() === from.id).length >= HELPERS_PER_LEAD) return answer(`Refused: you lead ${HELPERS_PER_LEAD} live helpers already; close one first.`, true);
    if (peers.filter((p) => p.lead()).length + (from.lead() ? 1 : 0) >= HELPERS_PER_PROJECT) return answer(`Refused: this project has ${HELPERS_PER_PROJECT} live helpers already.`, true);
    if (chainOf(from.id).hops + 1 >= MAX_HOPS) return answer(`Refused: a chain of messages may pass ${MAX_HOPS} agents at most.`, true);
    let helper: BusAgent;
    try {
      helper = await o.spawn(from, provider, cwd ?? from.root());
    } catch (e) {
      return answer(`The helper did not start: ${e instanceof Error ? e.message : String(e)}`, true);
    }
    const r = await deliver(from, helper, task, true, signal, progress);
    const first = (r.content[0] as Text | undefined)?.text ?? '';
    return { ...r, content: [{ type: 'text', text: `Helper ${helper.id} (${provider}) started.\n\n${first}` }] };
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
      forgetPending(id);
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
            ...(p.lead() ? { lead: p.lead() } : {}),
          })), null, 2));
        }
        const more = args as { provider?: unknown; task?: unknown; cwd?: unknown; id?: unknown };
        if (r.params.name === 'close') {
          const target = typeof more.id === 'string' ? o.get(more.id) : undefined;
          if (!target || target.lead() !== id || !o.close) return answer(`No helper ${String(more.id)} of yours.`, true);
          o.close(target.id);
          return answer(`Closed ${target.id}.`);
        }
        const token = r.params._meta?.progressToken;
        let n = 0;
        const progress = (step: string) => {
          if (token === undefined) return;
          void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: step } }).catch(() => {});
        };
        if (r.params.name === 'spawn') {
          if (typeof more.provider !== 'string' || typeof more.task !== 'string' || !more.task.trim()) return answer('provider and task are required.', true);
          return spawn(from, more.provider, more.task, typeof more.cwd === 'string' ? more.cwd : undefined, extra.signal, progress);
        }
        if (r.params.name !== 'ask' && r.params.name !== 'tell') return answer(`No tool ${r.params.name}.`, true);
        if (typeof args.to !== 'string' || typeof args.text !== 'string' || !args.text.trim()) return answer('to and text are required.', true);
        return send(from, args.to, args.text, r.params.name === 'ask', extra.signal, progress);
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    },
  };
}
