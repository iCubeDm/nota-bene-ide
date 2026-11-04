import { EFFORT_LEVELS, type AgentEvent, type AgentEffort as EffortLevel, type Interaction, type AgentMode as Mode, type ModelOption, type ServerEvent, type SlashCommand, type Stats } from '@nota-bene/shared';
import type { ProviderSession as AgentSession, ProviderStartOptions as StartOptions } from '../types.ts';
import { validateForm } from '../form.ts';
import { array, record, string } from '../json.ts';
import type { AcpProfile } from './backend.ts';
import { AcpError, type AcpConnection, type AcpRequest } from './rpc.ts';
import { AcpMapper, acpPrompt } from './map.ts';

/** One `session/prompt` in flight; a steered prompt folds its messages into the one that goes on. */
type Ticket = { uuids: string[]; at: number; done: Promise<void>; resolve(): void };
function ticket(uuid: string): Ticket { let resolve!: () => void; const done = new Promise<void>((r) => { resolve = r; }); return { uuids: [uuid], at: Date.now(), done, resolve }; }

/** `version` when it is below `min` (both `x.y.z`); a version we cannot read passes: only a known old agent is refused. */
export function tooOld(version: string, min: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return null;
  const want = min.split('.').map(Number), at = [Number(m[1]), Number(m[2]), Number(m[3])];
  const i = at.findIndex((n, k) => n !== want[k]);
  return i >= 0 && at[i]! < want[i]! ? at.join('.') : null;
}

const effortOf = (thinking: string): EffortLevel | undefined =>
  thinking === 'off' ? 'none' : (EFFORT_LEVELS as readonly string[]).includes(thinking) ? thinking as EffortLevel : undefined;
const thinkingOf = (effort: EffortLevel): string => effort === 'none' ? 'off' : effort;
const errorText = (e: unknown): string => e instanceof AcpError ? string(record(e.data).details) || e.message : e instanceof Error ? e.message : String(e);

type Config = { models: { value: string; name: string }[]; thinking: string[]; model: string | null; level: string | null };
function readConfig(value: unknown): Config {
  const out: Config = { models: [], thinking: [], model: null, level: null };
  for (const o of array(value).map(record)) {
    const options = array(o.options).map(record), current = string(o.currentValue) || null;
    if (o.id === 'model') { out.models = options.map((v) => ({ value: string(v.value), name: string(v.name) || string(v.value) })).filter((v) => v.value); out.model = current; }
    if (o.id === 'thinking') { out.thinking = options.map((v) => string(v.value)).filter(Boolean); out.level = current; }
  }
  return out;
}

/** What `session/load` replays: user text, tool rows and final replies, ts 0; `blocks`: how many reply blocks it held. */
export async function captureReplay(rpc: AcpConnection, sessionId: string, cwd: string): Promise<{ events: ServerEvent[]; configOptions: unknown; blocks: number; commands?: Record<string, unknown> }> {
  const events: ServerEvent[] = [], mapper = new AcpMapper();
  let user: string | undefined, userMid = '', n = 0, commands: Record<string, unknown> | undefined;
  const agent = (list: AgentEvent[]) => {
    for (const e of list) if (!['init', 'rate-limit', 'commands', 'message-start', 'message-chunk'].includes(e.t)) events.push({ kind: 'agent', e: e as Extract<ServerEvent, { kind: 'agent' }>['e'], ts: 0 });
  };
  const flushUser = () => { if (user !== undefined) { events.push({ kind: 'user', id: 'acp-u' + (++n), text: user, ts: 0, historic: true }); user = undefined; userMid = ''; } };
  const off = rpc.onNotification((method, p) => {
    if (method !== 'session/update' || p.sessionId !== sessionId) return;
    const u = record(p.update);
    if (u.sessionUpdate === 'available_commands_update') commands = u;
    if (u.sessionUpdate === 'user_message_chunk') {
      const mid = string(u.messageId);
      // each user-role entry of the transcript is its own message
      if (user !== undefined && mid && userMid && mid !== userMid) flushUser();
      if (user === undefined) agent(mapper.flush());
      user = (user ?? '') + string(record(u.content).text); userMid = mid || userMid;
      return;
    }
    if (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') flushUser();
    agent(mapper.update(u));
  });
  try {
    const r = record(await rpc.request('session/load', { sessionId, cwd, mcpServers: [] }, { timeoutMs: 120_000 }));
    flushUser(); agent(mapper.flush());
    return { events, configOptions: r.configOptions, blocks: mapper.blocks, ...(commands ? { commands } : {}) };
  } finally { off(); }
}

/** One owned ACP agent process per conversation; an approval-level change respawns it while idle. */
export class AcpSession implements AgentSession {
  readonly ready: Promise<void>;
  readonly messages: AsyncIterable<AgentEvent>;
  private readonly events: AgentEvent[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private failure: Error | undefined;
  private chain = Promise.resolve();
  private stopGeneration = 0;
  private askCtl = new AbortController();
  private rpc: AcpConnection;
  private respawning = false;
  private replaying = false;
  private quiet = false;
  private sid = '';
  private mode: Mode;
  private model: string | null = null;
  private effort: EffortLevel | null;
  private config: Config = { models: [], thinking: [], model: null, level: null };
  private context: Stats['context'] = null;
  private cost = 0;
  private active: Ticket[] = [];
  private mapper: AcpMapper;
  private commandsSeen: () => void = () => {};
  private readonly commandsReady = new Promise<void>((r) => { this.commandsSeen = r; });
  private readonly o: StartOptions;
  private readonly profile: AcpProfile;
  private readonly connect: (mode: Mode) => AcpConnection;
  private readonly adopted: { mode: Mode; configOptions: unknown; commands?: Record<string, unknown> } | undefined;

  /** `adopted`: the replay's process and what it learned (3d); `blocks`: reply blocks the conversation already has */
  constructor(o: StartOptions, profile: AcpProfile, connect: (mode: Mode) => AcpConnection, adopted?: { rpc: AcpConnection; mode: Mode; sessionId: string; configOptions: unknown; blocks: number; commands?: Record<string, unknown> }, blocks = adopted?.blocks ?? 0) {
    this.o = o; this.profile = profile; this.connect = connect;
    this.mode = adopted?.mode ?? o.permissionMode; this.effort = o.effort ?? null;
    this.messages = { [Symbol.asyncIterator]: () => this.read() };
    this.closed = new Promise((r) => { this.closedResolve = r; });
    this.mapper = new AcpMapper(blocks);
    this.rpc = adopted?.rpc ?? connect(o.permissionMode);
    if (adopted) { this.sid = adopted.sessionId; this.adopted = { mode: adopted.mode, configOptions: adopted.configOptions, ...(adopted.commands ? { commands: adopted.commands } : {}) }; }
    this.bind(this.rpc);
    this.ready = this.open();
    void this.ready.catch((e) => this.fail(e));
  }

  /** resolves once the session ended and its process is gone (a respawn does not end it) */
  readonly closed: Promise<void>;
  private closedResolve!: () => void;
  get sessionId(): string { return this.sid; }

  private bind(rpc: AcpConnection) {
    rpc.onNotification((m, p) => { if (rpc === this.rpc) this.notification(m, p); });
    rpc.onRequest((r, s) => this.answer(r, AbortSignal.any([s, this.askCtl.signal])));
    void rpc.closed.then(() => { if (!this.ended && !this.respawning && rpc === this.rpc) this.fail(new Error(this.profile.errors.disconnected)); });
  }
  private push(e: AgentEvent) { if (!this.ended) { this.events.push(e); this.wake?.(); } }
  private async *read(): AsyncGenerator<AgentEvent> {
    for (;;) {
      if (this.events.length) { yield this.events.shift()!; continue; }
      if (this.ended) { if (this.failure) throw this.failure; return; }
      await new Promise<void>((r) => { this.wake = r; }); this.wake = undefined;
    }
  }
  private fail(e: unknown) { this.failure = e instanceof Error ? e : new Error(String(e)); this.close(); }

  private async handshake(rpc: AcpConnection) {
    const old = tooOld(string(record(record(await rpc.ready).agentInfo).version), this.profile.minVersion);
    if (old) throw new Error(this.profile.errors.tooOld(old));
  }
  private set(configId: 'mode' | 'model' | 'thinking', value: string) {
    return this.rpc.request('session/set_config_option', { sessionId: this.sid, configId, value });
  }
  /** after a new/load/fork: the wanted model, effort and ACP mode on top of what the agent reports */
  private async configure(configOptions: unknown, wanted: string | null) {
    this.config = readConfig(configOptions);
    this.model = wanted && this.config.models.some((m) => m.value === wanted) ? wanted : this.config.model;
    if (this.model && this.model !== this.config.model) await this.set('model', this.model);
    if (this.effort && !this.efforts().includes(this.effort)) this.effort = null;
    if (this.effort && thinkingOf(this.effort) !== this.config.level) await this.set('thinking', thinkingOf(this.effort));
    if (this.profile.acpMode(this.mode) !== 'default') await this.set('mode', this.profile.acpMode(this.mode));
  }

  private async open(): Promise<void> {
    const o = this.o;
    await this.handshake(this.rpc);
    let configOptions: unknown;
    if (this.adopted) configOptions = this.adopted.configOptions;
    else if (o.resume) {
      // a fork never takes the source over; any other resume must not share a conversation another omp process holds
      if (!o.fork) await this.profile.beforeResume?.(o.resume);
      if (o.fork) {
        const r = record(await this.rpc.request('session/fork', { sessionId: o.resume, cwd: o.cwd, mcpServers: [] }));
        this.sid = string(r.sessionId); configOptions = r.configOptions;
      } else {
        this.sid = o.resume; this.replaying = true;
        try { configOptions = record(await this.rpc.request('session/load', { sessionId: o.resume, cwd: o.cwd, mcpServers: [] }, { timeoutMs: 120_000 })).configOptions; }
        finally { this.replaying = false; }
        this.mapper.flush();
      }
    } else {
      const r = record(await this.rpc.request('session/new', { cwd: o.cwd, mcpServers: [] }));
      this.sid = string(r.sessionId); configOptions = r.configOptions;
    }
    if (this.ended) return;
    if (!this.sid) throw new Error(`${this.profile.name} did not return a session id`);
    await this.configure(configOptions, o.model ?? null);
    if (this.mode !== o.permissionMode) await this.changeMode(o.permissionMode);
    if (this.ended) return;
    this.push({ t: 'init', sessionId: this.sid, ...(this.model ? { model: this.model } : {}), mode: this.mode });
    if (this.adopted?.commands) this.notification('session/update', { sessionId: this.sid, update: this.adopted.commands });
  }

  private notification(method: string, p: Record<string, unknown>): void {
    if (this.ended || method !== 'session/update' || p.sessionId !== this.sid) return;
    const u = record(p.update);
    // the replay is not shown, but it counts the reply blocks so that live ids continue its numbering
    if (this.replaying) { this.mapper.update(u); return; }
    if (this.quiet && (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk')) return;
    if (u.sessionUpdate === 'current_mode_update') {
      // omp leaves plan mode itself when a plan is approved: follow it
      const mode = this.profile.capabilities.modes.find((m) => this.profile.sameProcess(m, this.mode) && this.profile.acpMode(m) === string(u.currentModeId));
      if (mode && mode !== this.mode && !this.respawning) { this.mode = mode; this.push({ t: 'mode', mode }); }
      return;
    }
    if (u.sessionUpdate === 'usage_update') {
      if (typeof u.used === 'number' && typeof u.size === 'number' && u.size > 0) this.context = { used: u.used, max: u.size, pct: u.used / u.size * 100 };
      const amount = record(u.cost).amount;
      if (typeof amount === 'number') this.cost = amount;
      return;
    }
    for (const e of this.mapper.update(u)) {
      if (e.t === 'commands') { this.commandsSeen(); this.push({ t: 'commands', commands: this.visibleCommands() }); } else this.push(e);
    }
  }
  private visibleCommands(): SlashCommand[] {
    return [{ name: 'clear', description: 'Start a new conversation', builtin: true },
      ...this.mapper.commands.filter((c) => !this.profile.hideCommands.has(c.name)).map((c) => c.name === 'compact' ? { ...c, builtin: true } : c)];
  }

  private async answer(r: AcpRequest, signal: AbortSignal): Promise<unknown> {
    const p = r.params, o = this.o;
    if (p.sessionId && p.sessionId !== this.sid) throw new Error('Request from another ACP session');
    if (r.method === 'session/request_permission') {
      const tc = record(p.toolCall), options = array(p.options).map(record);
      const choices = options.map((opt) => ({ id: string(opt.optionId), label: string(opt.name) || string(opt.optionId), allow: string(opt.kind).startsWith('allow') }));
      const input = record(tc.rawInput), title = string(tc.title) || string(tc.toolCallId) || this.profile.name;
      let choice: string | undefined;
      if (o.interact) choice = (await o.interact({ title, choices }, input, signal))?.choice;
      else {
        const allow = await o.ask(title, input, signal);
        const pick = (kind: string, fallback: (k: string) => boolean) => options.find((opt) => opt.kind === kind) ?? options.find((opt) => fallback(string(opt.kind)));
        choice = string(pick(allow ? 'allow_once' : 'reject_once', (k) => k.startsWith('allow') === allow)?.optionId) || undefined;
      }
      return choice && choices.some((c) => c.id === choice) ? { outcome: { outcome: 'selected', optionId: choice } } : { outcome: { outcome: 'cancelled' } };
    }
    if (r.method === 'elicitation/create') {
      if (!o.interact) return { action: 'cancel' };
      if (p.mode === 'url') {
        const choices = [{ id: 'accept', label: 'Accept' }, { id: 'decline', label: 'Decline' }, { id: 'cancel', label: 'Cancel' }];
        const a = await o.interact({ title: string(p.message) || this.profile.name, ...(/^https?:\/\//.test(string(p.url)) ? { url: string(p.url) } : {}), choices }, {}, signal);
        return { action: a && choices.some((c) => c.id === a.choice) ? a.choice : 'cancel' };
      }
      const schema = record(p.requestedSchema), message = string(p.message);
      const form = this.profile.approvalForm(message, schema);
      if (form) {
        const a = await o.interact({ title: form.title, choices: form.choices }, this.mapper.pendingCall(form.tool) ?? { details: form.details }, signal);
        // a denial is an accepted form carrying the deny value: that is how the agent reads the answer
        return a && form.choices.some((c) => c.id === a.choice) ? { action: 'accept', content: { [form.property]: a.choice } } : { action: 'cancel' };
      }
      const props = record(schema.properties), required = array(schema.required);
      const fields: NonNullable<Interaction['fields']> = Object.entries(props).map(([id, raw]) => {
        const s = record(raw), items = record(s.items);
        const options = [array(s.enum), array(s.oneOf).map((x) => record(x).const), array(items.enum), array(items.anyOf).map((x) => record(x).const)].find((l) => l.length)?.filter((v): v is string => typeof v === 'string') ?? [];
        return { id, label: string(s.title) || id, ...(options.length ? { options } : {}), required: required.includes(id) };
      });
      const a = await o.interact({ title: message || this.profile.name, choices: [{ id: 'accept', label: 'Send answers' }, { id: 'cancel', label: 'Cancel' }], fields }, { message }, signal);
      if (!a || a.choice !== 'accept') return { action: a?.choice === 'decline' ? 'decline' : 'cancel' };
      const content: Record<string, unknown> = {};
      for (const f of fields) {
        const v = a.values?.[f.id], type = record(props[f.id]).type;
        if (!v) continue;
        content[f.id] = type === 'boolean' ? v === 'true' : type === 'number' || type === 'integer' ? Number(v) : type === 'array' ? [v] : v;
      }
      validateForm(content, schema);
      return { action: 'accept', content };
    }
    throw new Error(`Unsupported ACP request: ${r.method}`);
  }

  send(m: Parameters<AgentSession['send']>[0]): void {
    if (this.ended) return;
    const generation = this.stopGeneration;
    const run = this.chain.then(async () => {
      await this.ready; if (this.ended) return;
      if (generation !== this.stopGeneration) { this.push({ t: 'cancelled', sendId: m.uuid }); return; }
      await this.dispatch(m);
    });
    this.chain = run.catch((e) => { this.push({ t: 'turn-end', stop: 'failed', secs: 0, answers: [m.uuid], queued: 0, error: errorText(e) }); });
  }
  private async dispatch(m: Parameters<AgentSession['send']>[0]): Promise<void> {
    const name = this.profile.name;
    if (m.priority === 'now' && this.active.length) {
      const waiting = this.active.map((t) => t.done);
      this.cancelAsks(); this.rpc.notify('session/cancel', { sessionId: this.sid });
      await Promise.race([Promise.all(waiting), new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error(`${name} has not finished cancelling; retry after it stops.`)), 30_000); t.unref(); void Promise.all(waiting).then(() => clearTimeout(t)); })]);
      if (this.ended) return;
    }
    if (/^\/clear\s*$/.test(m.text)) {
      if (this.active.length) throw new Error(`Wait for ${name} to finish before clearing`);
      const old = this.sid;
      const r = record(await this.rpc.request('session/new', { cwd: this.o.cwd, mcpServers: [] }));
      if (!string(r.sessionId)) throw new Error(`${name} did not return a session id`);
      this.sid = string(r.sessionId); this.mapper = new AcpMapper(); this.context = null; this.cost = 0; this.cancelAsks();
      void this.rpc.request('session/close', { sessionId: old }).catch(() => {});
      await this.configure(r.configOptions, this.model);
      this.push({ t: 'reset', newId: this.sid });
      this.push({ t: 'init', sessionId: this.sid, ...(this.model ? { model: this.model } : {}), mode: this.mode });
      this.push({ t: 'turn-end', stop: 'done', secs: 0, answers: [m.uuid], queued: 0 });
      return;
    }
    const t = ticket(m.uuid);
    this.active.push(t);
    // never awaited here: the chain takes the next send (a steer) while this prompt streams
    const sent = this.rpc.request('session/prompt', { sessionId: this.sid, prompt: acpPrompt(m.text, m.images) }, { timeoutMs: 0 });
    void sent.then((r) => this.settle(t, record(r)), (e) => this.settle(t, undefined, e));
  }
  private settle(t: Ticket, r?: Record<string, unknown>, e?: unknown) {
    const i = this.active.indexOf(t);
    if (i < 0) return;
    this.active.splice(i, 1);
    const stop = string(r?.stopReason);
    const next = this.active.at(-1);
    if (!e && stop === 'cancelled' && next) {
      // a steer: the agent goes on with both messages in the newer prompt; what the old run asked will not be read
      next.uuids.unshift(...t.uuids); next.at = Math.min(next.at, t.at); this.cancelAsks(); t.resolve(); return;
    }
    for (const ev of this.mapper.flush()) this.push(ev);
    const error = e ? (e instanceof AcpError && e.code === -32000 ? this.profile.errors.auth : errorText(e)) : stop === 'refusal' ? `${this.profile.name} refused the request` : '';
    this.push({ t: 'turn-end', stop: e || stop === 'refusal' ? 'failed' : stop === 'cancelled' ? 'interrupted' : 'done', secs: (Date.now() - t.at) / 1000, answers: t.uuids, queued: 0, ...(error ? { error } : {}) });
    t.resolve();
  }
  private cancelAsks() { this.askCtl.abort(); this.askCtl = new AbortController(); }
  async interrupt(): Promise<void> {
    this.stopGeneration++; this.cancelAsks();
    if (this.active.length) this.rpc.notify('session/cancel', { sessionId: this.sid });
  }

  /** one at a time, in order with the sends: a send during a respawn waits for the new process */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => { await this.ready; return fn(); });
    this.chain = run.then(() => {}, () => {});
    return run;
  }
  setPermissionMode(next: Mode): Promise<void> { return this.serial(() => this.changeMode(next)); }
  private async changeMode(next: Mode): Promise<void> {
    if (!this.profile.capabilities.modes.includes(next)) throw new Error(`Unsupported ${this.profile.name} mode`);
    if (next === this.mode) return;
    if (this.profile.sameProcess(this.mode, next)) {
      await this.set('mode', this.profile.acpMode(next)); this.mode = next; return;
    }
    if (this.active.length) throw new Error(`Wait for ${this.profile.name} to finish before changing the mode`);
    await this.respawn(next);
  }
  /** a new process with other launch flags, on the same stored conversation */
  private async respawn(next: Mode) {
    this.respawning = true;
    try {
      await this.rpc.close();
      if (this.ended) return;
      const rpc = this.connect(next);
      this.rpc = rpc; this.mapper = new AcpMapper(); this.cancelAsks(); this.bind(rpc);
      await this.handshake(rpc);
      this.replaying = true;
      let configOptions: unknown;
      try { configOptions = record(await rpc.request('session/load', { sessionId: this.sid, cwd: this.o.cwd, mcpServers: [] }, { timeoutMs: 120_000 })).configOptions; }
      finally { this.replaying = false; }
      this.mapper.flush(); // the replay's last text block must not come out again with the next live message
      this.mode = next;
      await this.configure(configOptions, this.model);
    } catch (e) { this.fail(e); throw e; }
    finally { this.respawning = false; }
  }

  private efforts(): EffortLevel[] { return this.config.thinking.map(effortOf).filter((e): e is EffortLevel => !!e); }
  async supportedModels(): Promise<ModelOption[]> {
    await this.ready;
    const efforts = this.efforts(), defaultEffort = this.config.level ? effortOf(this.config.level) : undefined;
    return this.config.models.map((m) => ({ value: m.value, name: m.name, description: m.value, resolved: m.value, efforts, ...(defaultEffort ? { defaultEffort } : {}) }));
  }
  setModel(model: string | null): Promise<void> {
    return this.serial(async () => {
      if (model && !this.config.models.some((m) => m.value === model)) throw new Error(`Unknown ${this.profile.name} model`);
      const value = model ?? this.config.model;
      if (value) await this.set('model', value);
      this.model = value;
    });
  }
  setEffort(effort: EffortLevel | null): Promise<void> {
    return this.serial(async () => {
      if (effort && !this.efforts().includes(effort)) throw new Error(`Unsupported ${this.profile.name} reasoning effort`);
      const value = effort ? thinkingOf(effort) : this.config.thinking.includes('auto') ? 'auto' : this.config.level;
      if (value) await this.set('thinking', value);
      this.effort = effort;
    });
  }
  async supportedCommands(): Promise<SlashCommand[]> {
    await this.ready;
    await Promise.race([this.commandsReady, new Promise<void>((r) => { setTimeout(r, 2000).unref(); })]);
    return this.visibleCommands();
  }
  async fileSuggestions(): Promise<string[]> { throw new Error(`${this.profile.name} has no file search over ACP`); }
  async rename(title: string): Promise<void> {
    if (this.active.length) throw new Error(`Wait for ${this.profile.name} to finish before renaming`);
    this.quiet = true;
    try { await this.rpc.request('session/prompt', { sessionId: this.sid, prompt: [{ type: 'text', text: `/rename ${title}` }] }); }
    finally { this.quiet = false; }
  }
  async contextUsage(): Promise<Stats['context']> { return this.context; }
  async usage(): Promise<{ cost: number; limits: null }> { return { cost: this.cost, limits: null }; }
  async stopTask(): Promise<void> { throw new Error(`${this.profile.name} has no task controls over ACP`); }
  async backgroundTask(): Promise<boolean> { throw new Error(`${this.profile.name} cannot move a task to the background`); }
  async taskOutput(): Promise<never> { throw new Error(`${this.profile.name} does not expose task output`); }
  close(): void {
    if (this.ended) return; this.ended = true; this.askCtl.abort();
    for (const t of this.active) t.resolve();
    this.wake?.(); void this.rpc.close().finally(this.closedResolve);
  }
}
