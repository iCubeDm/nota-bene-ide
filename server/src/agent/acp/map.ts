import { createHash } from 'node:crypto';
import { cutTail, type AgentEvent, type SlashCommand } from '@nota-bene/shared';
import type { SendImage } from '../types.ts';
import { array, record, string } from '../json.ts';

const CAP = 64 * 1024;
type Call = Extract<AgentEvent, { t: 'tool-call' }>;

/** Native ids are opaque, never paths. The same transform is used for live/replay/routes. */
export function acpId(id: string): string {
  return 'acp-' + (/^[A-Za-z0-9_-]{1,110}$/.test(id) ? id : createHash('sha256').update(id).digest('hex'));
}

export function acpPrompt(text: string, images?: SendImage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ type: 'text', text: text || ' ' }];
  for (const image of images ?? []) {
    out.push({ type: 'text', text: image.label || '[image]' });
    out.push({ type: 'image', mimeType: image.mediaType, data: image.data });
  }
  return out;
}

/** ACP's tool kinds; never `agent`: an ACP agent gives no child session, and that kind opens a subagent card. */
export const toolKind = (kind: string): NonNullable<Call['toolKind']> =>
  kind === 'execute' ? 'command' : ['edit', 'delete', 'move', 'read'].includes(kind) ? 'file' : ['search', 'fetch'].includes(kind) ? 'search' : 'other';

/** The result text of a finished tool call: its raw output, else its (full, not delta) content. */
export function updateText(update: Record<string, unknown>): string {
  const raw = record(update.rawOutput).content;
  if (Array.isArray(raw)) return cutTail(raw.map((part) => string(record(part).text)).filter(Boolean).join('\n'), CAP);
  const parts = array(update.content).map(record).flatMap((part) => {
    if (part.type === 'content') return [string(record(part.content).text)];
    if (part.type === 'diff') return [`${string(part.path)}\n${string(part.newText)}`];
    return [];
  });
  return cutTail(parts.filter(Boolean).join('\n'), CAP);
}

/**
 * ACP `session/update`s → AgentEvents. One per conversation; replay uses a fresh one.
 * Reply ids count the text blocks of the conversation (`acp-b<n>`): the agent's own message ids change on every load,
 * and a live session continues the count of the replay it follows, so a comment keeps its anchor across reloads.
 */
export class AcpMapper {
  private open: { id: string; mid: string; text: string } | undefined;
  private readonly calls = new Map<string, { name: string; input: Record<string, unknown>; done: boolean }>();
  /** text blocks emitted so far */
  blocks: number;
  commands: SlashCommand[] = [];

  constructor(blocks = 0) { this.blocks = blocks; }

  update(u: Record<string, unknown>): AgentEvent[] {
    const out: AgentEvent[] = [];
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = string(record(u.content).text);
        if (!text) return out; // an image chunk opens no text block
        const mid = string(u.messageId);
        if (this.open && mid && this.open.mid && this.open.mid !== mid) out.push(...this.flush());
        if (!this.open) { out.push({ t: 'message-start' }); this.open = { id: `b${this.blocks++}`, mid, text: '' }; }
        this.open.text += text; out.push({ t: 'message-chunk', text });
        return out;
      }
      case 'tool_call': {
        out.push(...this.flush());
        const raw = string(u.toolCallId);
        if (!raw) return out;
        if (!this.calls.has(raw)) {
          const name = string(u.name) || string(u.title) || 'tool', input = record(u.rawInput);
          this.calls.set(raw, { name, input, done: false });
          out.push({ t: 'tool-call', id: acpId(raw), name, input, sub: false, toolKind: toolKind(string(u.kind)) });
        }
        if (u.status === 'completed' || u.status === 'failed') out.push(...this.finish(raw, u));
        return out;
      }
      case 'tool_call_update': return u.status === 'completed' || u.status === 'failed' ? this.finish(string(u.toolCallId), u) : [];
      case 'available_commands_update': {
        this.commands = array(u.availableCommands).map(record).map((c) => {
          const hint = string(record(c.input).hint);
          return { name: string(c.name), description: string(c.description), ...(hint ? { hint } : {}) };
        }).filter((c) => c.name);
        return [{ t: 'commands', commands: this.commands }];
      }
      default: return [];
    }
  }

  /** The streaming text block's final `message`, when one is open. */
  flush(): AgentEvent[] {
    const open = this.open; this.open = undefined;
    return open && open.text ? [{ t: 'message', id: acpId(open.id), text: open.text }] : [];
  }

  /** The input of the newest unfinished call of tool `name` (approval forms carry only its name). */
  pendingCall(name: string): Record<string, unknown> | undefined {
    let found: Record<string, unknown> | undefined;
    for (const c of this.calls.values()) if (c.name === name && !c.done) found = c.input;
    return found;
  }

  private finish(raw: string, u: Record<string, unknown>): AgentEvent[] {
    const call = this.calls.get(raw);
    if (!call || call.done) return [];
    call.done = true;
    return [{ t: 'tool-update', id: acpId(raw), text: updateText(u), isError: u.status === 'failed' }];
  }
}
