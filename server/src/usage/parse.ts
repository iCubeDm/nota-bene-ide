// Transcript lines to normalized usage records. Pure: the reading, the offsets and the merging are elsewhere.
import path from 'node:path';
import { BATCH_HEAD, type TokenCounts } from '@nota-bene/shared';

/** `id`: one API call; repeated ids merge, field by field, to the maximum (store.ts). `task`: set when the transcript names it. */
export type CallRecord = TokenCounts & { k: 'c'; id: string; ts: number; cwd: string; session: string; model: string; agent?: string; task?: string };
export type PromptRecord = { k: 'p'; ts: number; session: string; label: string; task?: string };
export type AgentRecord = { k: 'a'; id: string; label: string };
/** `resets`: from a live event, in ms; the same value is the same window. `overage`: the work went on on extra usage. */
export type HitRecord = { k: 'h'; ts: number; kind: '5h' | 'week'; resets?: number; overage?: boolean };
/** A limit reading: `pct` of the `minutes`-long window that resets at `resets`. */
export type LimitRecord = { k: 'l'; ts: number; minutes: number; pct: number; resets: number | null };
/** Extra usage spent so far in the billing period, in minor units of `currency`. */
export type SpendRecord = { k: 'x'; ts: number; used: number; limit: number | null; currency: string | null };
export type UsageRecord = CallRecord | PromptRecord | AgentRecord | HitRecord | LimitRecord | SpendRecord;

export const LABEL_MAX = 64;

/** Where a Claude transcript sits: `<project>/<session>.jsonl` or `<project>/<session>/subagents/agent-<id>.jsonl`. */
export function claudeFile(rel: string): { session: string; agent?: string } {
  const parts = rel.split(path.sep);
  const base = parts[parts.length - 1]!.replace(/\.jsonl$/, '');
  return parts.includes('subagents') ? { session: parts[1]!, agent: base.replace(/^agent-/, '') } : { session: base };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
const label = (text: string): string => text.trim().replace(/\s+/g, ' ').slice(0, LABEL_MAX);


/** A prompt's label. A batch says little in its first words: the words above it, or else its first comment, not the quote. */
function promptLabel(text: string): string {
  const head = BATCH_HEAD.exec(text);
  if (!head) return label(text);
  const body = text.slice(head.index + head[0].length);
  return label(text.slice(0, head.index)) || label(/^→ (.+)$/m.exec(body)?.[1] ?? body);
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => { const t = obj(b).text; return typeof t === 'string' ? t : ''; }).join(' ');
};

/** Under a temporary folder: smoke runs and tests, not work. */
export function isTempDir(cwd: string, tmp: readonly string[]): boolean {
  return tmp.some((d) => cwd === d || cwd.startsWith(d + path.sep));
}

/** The CLI's limit names; group 1 is the 5-hour one. Spend, budget, fast and credit limits share the wording and are no such window. */
const CLAUDE_HIT = /(?:hit|reached) your (?:(session|5-hour)|weekly|Opus|Sonnet|Fable) limit/;

/** One line of a Claude transcript. `file`: what claudeFile said. A cheap check first: most lines carry nothing here. */
export function parseClaudeLine(line: string, file: { session: string; agent?: string }): UsageRecord[] {
  if (!line.includes('"assistant"') && !line.includes('"user"')) return [];
  let j: Record<string, unknown>;
  try { j = obj(JSON.parse(line)); } catch { return []; }
  const ts = Date.parse(typeof j.timestamp === 'string' ? j.timestamp : '');
  if (!ts) return [];
  const message = obj(j.message);
  if (j.type === 'user') {
    if (file.agent || j.isMeta || j.isSidechain || j.isCompactSummary) return []; // a compaction goes on with the same task
    const content = message.content;
    if (Array.isArray(content) && content.some((b) => obj(b).type === 'tool_result')) return [];
    const text = promptLabel(textOf(content));
    return text && !text.startsWith('<') ? [{ k: 'p', ts, session: file.session, label: text }] : [];
  }
  if (j.type !== 'assistant') return [];
  if (j.isApiErrorMessage || j.error) {
    const hit = CLAUDE_HIT.exec(textOf(message.content));
    return hit ? [{ k: 'h', ts, kind: hit[1] ? '5h' : 'week' }] : [];
  }
  const u = obj(message.usage);
  const model = typeof message.model === 'string' ? message.model : '';
  if (typeof message.id !== 'string' || !model || model === '<synthetic>' || !('output_tokens' in u)) return [];
  return [{
    k: 'c', id: message.id, ts, cwd: typeof j.cwd === 'string' ? j.cwd : '', session: file.session, model,
    in: num(u.input_tokens), out: num(u.output_tokens), write: num(u.cache_creation_input_tokens), read: num(u.cache_read_input_tokens),
    ...(file.agent ? { agent: file.agent } : {}),
  }];
}

/** What a Claude subagent's `.meta.json` names it. */
export function claudeAgentRecord(id: string, meta: string): AgentRecord | null {
  let j: Record<string, unknown>;
  try { j = obj(JSON.parse(meta)); } catch { return null; }
  const type = j.agentType === 'general-purpose' ? '' : j.agentType; // the default says nothing
  const text = [type, j.description].filter((s) => typeof s === 'string' && s).join(': ');
  return text ? { k: 'a', id, label: label(text) } : null;
}

/** What a Codex rollout said earlier: it is needed by the lines after it, and it survives between imports. */
export type CodexContext = { thread?: string; session?: string; cwd?: string; model?: string; agent?: string; limits?: Record<string, number> };

/** One line of a Codex rollout; it may also update `c`. */
export function parseCodexLine(line: string, c: CodexContext): UsageRecord[] {
  if (!/"(session_meta|turn_context|token_usage_record|token_count|item_completed)"/.test(line)) return [];
  let j: Record<string, unknown>;
  try { j = obj(JSON.parse(line)); } catch { return []; }
  const ts = Date.parse(typeof j.timestamp === 'string' ? j.timestamp : '');
  const p = obj(j.payload);
  if (j.type === 'session_meta') return codexMeta(p, c);
  if (j.type === 'turn_context') {
    if (typeof p.model === 'string') c.model = p.model;
    if (typeof p.cwd === 'string') c.cwd = p.cwd;
    return [];
  }
  if (!ts) return [];
  if (j.type === 'token_usage_record') return codexCall(p, ts, c);
  if (p.type === 'token_count') return codexLimits(obj(p.rate_limits), ts, c);
  if (p.type !== 'item_completed' || obj(p.item).type !== 'UserMessage' || c.agent) return [];
  const text = promptLabel(textOf(obj(p.item).content));
  return text && c.session && typeof p.turn_id === 'string' ? [{ k: 'p', ts, session: c.session, label: text, task: p.turn_id }] : [];
}

function codexMeta(p: Record<string, unknown>, c: CodexContext): UsageRecord[] {
  if (typeof p.id !== 'string') return [];
  c.thread = p.id;
  c.session = p.id;
  if (typeof p.cwd === 'string') c.cwd = p.cwd;
  const sub = obj(obj(p.source).subagent);
  const spawn = obj(sub.thread_spawn);
  if (!Object.keys(sub).length) return [];
  c.agent = p.id;
  if (typeof spawn.parent_thread_id === 'string') c.session = spawn.parent_thread_id;
  const name = [spawn.agent_role, spawn.agent_nickname, sub.other].filter((s) => typeof s === 'string' && s).join(': ');
  return name ? [{ k: 'a', id: p.id, label: label(name) }] : [];
}

function codexCall(p: Record<string, unknown>, ts: number, c: CodexContext): UsageRecord[] {
  const u = obj(p.usage);
  if (typeof p.response_id !== 'string' || !c.session || !c.model || !('output_tokens' in u)) return [];
  const read = num(u.cached_input_tokens), write = num(u.cache_write_input_tokens);
  return [{
    k: 'c', id: p.response_id, ts, cwd: c.cwd ?? '', session: c.session, model: c.model,
    in: Math.max(0, num(u.input_tokens) - read - write), out: num(u.output_tokens), write, read,
    ...(c.agent ? { agent: c.agent } : {}),
    ...(typeof p.root_turn_id === 'string' ? { task: p.root_turn_id } : {}),
  }];
}

const DAY_MINUTES = 1440;

/** Only what moved: one rollout repeats the same reading on every call. */
function codexLimits(r: Record<string, unknown>, ts: number, c: CodexContext): UsageRecord[] {
  const out: UsageRecord[] = [];
  const seen = c.limits ??= {};
  for (const w of [obj(r.primary), obj(r.secondary)]) {
    const minutes = num(w.window_minutes), pct = num(w.used_percent);
    if (!minutes || seen[minutes] === pct) continue;
    seen[minutes] = pct;
    out.push({ k: 'l', ts, minutes, pct, resets: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null });
  }
  if (r.rate_limit_reached_type === 'rate_limit_reached') { // the workspace_* reasons are credits and admin limits, no window
    const [full] = [obj(r.primary), obj(r.secondary)].sort((a, b) => num(b.used_percent) - num(a.used_percent) || num(b.window_minutes) - num(a.window_minutes));
    out.push({ k: 'h', ts, kind: num(full.window_minutes) >= DAY_MINUTES ? 'week' : '5h' });
  }
  return out;
}
