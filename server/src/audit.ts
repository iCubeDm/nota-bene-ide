import fs from 'node:fs';
import path from 'node:path';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { readPrefs } from './prefs.ts';
import { stateBaseDir } from './state.ts';

/**
 * The audit log: what happens in a window, one JSON line per event, for working out later what went wrong. System
 * events only: never what anyone wrote (messages, comments, commands, tool input or output, file contents). Every
 * window of the user writes into one file a day, `<NOTA_BENE_HOME>/audit/YYYY-MM-DD.jsonl`; `port` and `pid` tell the
 * windows apart, the `server-start` line names the project. On unless Settings → Defaults turns it off (`audit: false`).
 */
export type Fields = Record<string, string | number | boolean | null | undefined>;

export const KEEP_DAYS = 14;
export const MAX_DAY_BYTES = 50 * 1024 * 1024;
const PREF_MS = 5_000;
const TEXT_MAX = 300;

export const auditDir = (): string => path.join(stateBaseDir(), 'audit');
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** an error text: kept short, one line */
const short = (s: string | undefined) => (s === undefined ? undefined : s.replace(/\s+/g, ' ').slice(0, TEXT_MAX));

const active = new Set<AuditLog>();

/** For code with no window at hand (an agent adapter): goes to every audit log of this process. */
export function auditNote(ev: string, f: Fields = {}): void {
  for (const a of active) a.write(ev, f);
}

export class AuditLog {
  private bytes = new Map<string, number>(); // per day file: what it holds, as far as this process knows
  private capped = new Set<string>();
  private on: { value: boolean; at: number } | null = null;
  private broken = false;

  /** the window's port: the asked one until the server listens (a test's port 0 becomes the real one then) */
  port: number;

  private o: { port: number; dir?: string; now?: () => number; enabled?: () => boolean; maxDayBytes?: number };

  constructor(o: { port: number; dir?: string; now?: () => number; enabled?: () => boolean; maxDayBytes?: number }) {
    this.o = o;
    this.port = o.port;
    active.add(this);
  }

  close(): void {
    active.delete(this);
  }

  private enabled(): boolean {
    const now = Date.now();
    if (!this.on || now - this.on.at > PREF_MS) this.on = { value: this.o.enabled ? this.o.enabled() : readPrefs().audit !== false, at: now };
    return this.on.value;
  }

  write(ev: string, f: Fields = {}): void {
    if (this.broken || !this.enabled()) return;
    const ms = (this.o.now ?? Date.now)();
    const day = dayOf(ms);
    if (this.capped.has(day)) return;
    const dir = this.o.dir ?? auditDir();
    const file = path.join(dir, `${day}.jsonl`);
    const rec: Record<string, unknown> = { ts: new Date(ms).toISOString(), port: this.port, pid: process.pid, ev };
    for (const [k, v] of Object.entries(f)) if (v !== undefined) rec[k] = v;
    try {
      let size = this.bytes.get(day);
      if (size === undefined) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { size = fs.statSync(file).size; } catch { size = 0; }
      }
      const capped = size >= (this.o.maxDayBytes ?? MAX_DAY_BYTES);
      const line = `${JSON.stringify(capped ? { ts: rec.ts, port: this.port, pid: process.pid, ev: 'audit-capped', bytes: size } : rec)}\n`;
      // one append per line (O_APPEND): the windows sharing the file never cut into each other's lines
      fs.appendFileSync(file, line, { mode: 0o600 });
      this.bytes.set(day, size + Buffer.byteLength(line));
      if (capped) this.capped.add(day);
    } catch (e) {
      this.broken = true; // a log that cannot be written must never break the window: said once, then quiet
      console.error(`Nota Bene: the audit log is off for this run: ${(e as Error).message}`);
    }
  }

  /** Day files older than KEEP_DAYS go; anything else in the folder stays. */
  prune(): void {
    const dir = this.o.dir ?? auditDir();
    const oldest = dayOf((this.o.now ?? Date.now)() - KEEP_DAYS * 86_400_000);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(n);
      if (m && m[1]! < oldest) {
        try { fs.unlinkSync(path.join(dir, n)); } catch { /* another window got it first */ }
      }
    }
  }

  /** What the page asked for, without what it said: a message's text, a command, an answer's content stay out. */
  client(msg: ClientMessage, conn: number): void {
    const f: Fields = { conn, type: msg.type };
    switch (msg.type) {
      case 'send': Object.assign(f, { id: msg.id, chars: msg.text.length, force: msg.force, comments: msg.commentIds?.length, images: msg.images?.length }); break;
      case 'permission': Object.assign(f, { id: msg.id, allow: msg.allow }); break;
      case 'mode': Object.assign(f, { mode: msg.mode }); break;
      case 'model': Object.assign(f, { model: msg.model, effort: msg.effort }); break;
      case 'switch': Object.assign(f, { session: msg.id }); break;
      case 'command': Object.assign(f, { command: msg.name }); break;
      case 'task-stop': Object.assign(f, { task: msg.id }); break;
      case 'task-background': Object.assign(f, { tool: msg.toolUseId }); break;
      case 'shell-run': Object.assign(f, { id: msg.id, chars: msg.cmd.length }); break;
      case 'shell-stop': Object.assign(f, { id: msg.id }); break;
      case 'idle-compact': Object.assign(f, { on: msg.on }); break;
      case 'comments': Object.assign(f, { count: msg.items.length }); break;
      case 'activity': return; // a heartbeat of the page, not an event
      default: break;
    }
    this.write('client', f);
  }

  /** What the server told the window. Streamed text, tool input and output, comments and stats stay out. */
  server(ev: ServerEvent): void {
    const f = serverFields(ev);
    if (f) this.write('event', f);
  }
}

function serverFields(ev: ServerEvent): Fields | null {
  switch (ev.kind) {
    case 'agent': {
      const e = ev.e;
      switch (e.t) {
        case 'tool-call': return { kind: 'tool-call', id: e.id, tool: e.name, toolKind: e.toolKind, sub: e.sub };
        case 'tool-update': return { kind: 'tool-update', id: e.id, isError: e.isError };
        case 'turn-end': return { kind: 'turn-end', stop: e.stop, secs: e.secs, error: short(e.error), queued: e.queued };
        case 'cancelled': return { kind: 'cancelled', id: e.sendId };
        case 'compacting': case 'compact-end': return { kind: e.t };
        case 'compact-failed': return { kind: e.t, error: short(e.error) };
        case 'compacted': return { kind: e.t, preTokens: e.preTokens, ms: e.ms };
        case 'reset': return { kind: e.t, session: e.newId };
        case 'mode': return { kind: 'agent-mode', mode: e.mode };
        case 'task': return { kind: 'task', id: e.id, phase: e.phase, type: e.type, bg: e.bg, ambient: e.ambient, status: e.status };
        default: return null; // message text and its chunks, suggestions
      }
    }
    case 'user': return { kind: 'user', id: ev.id, chars: ev.text.length, force: ev.force, idle: ev.idle, images: ev.images?.length, historic: ev.historic };
    case 'permission': return { kind: 'permission', id: ev.id, tool: ev.toolName };
    case 'permission-done': return { kind: 'permission-done', id: ev.id, allow: ev.allow };
    case 'session': return { kind: 'session', session: ev.id, model: ev.model };
    case 'mode': return { kind: 'mode', mode: ev.mode };
    case 'model': return { kind: 'model', model: ev.model, effort: ev.effort };
    case 'resumed': return { kind: 'resumed', session: ev.id };
    case 'server-error': return { kind: 'server-error', where: ev.where, error: short(ev.message) };
    case 'send-refused': return { kind: 'send-refused', id: ev.id, reason: ev.reason };
    case 'shell-start': return { kind: 'shell-start', id: ev.id };
    case 'shell-end': return { kind: 'shell-end', id: ev.id, code: ev.code, stop: ev.stop, error: short(ev.error) };
    case 'shell-refused': return { kind: 'shell-refused', id: ev.id, reason: ev.reason };
    case 'occupied': case 'taken-over': return { kind: ev.kind };
    default: return null; // replay, hello, stats, comments, models, commands, shell output, idle-compact
  }
}
