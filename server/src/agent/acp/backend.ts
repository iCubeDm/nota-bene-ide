import fs from 'node:fs';
import path from 'node:path';
import type { AgentMode, Capabilities, Interaction } from '@nota-bene/shared';
import type { ProviderBackend as AgentBackend } from '../types.ts';
import { array, record, string } from '../json.ts';
import { AcpError, AcpRpc, CLIENT_VERSION, type AcpConnection } from './rpc.ts';
import { AcpSession, captureReplay } from './session.ts';

/** a tool approval the agent asks as a form, read back into a tool name and choices */
export type ApprovalForm = { tool: string; title: string; details: string; property: string; choices: Interaction['choices'] };

/** Everything one ACP agent needs beyond the protocol: binary, flags, form wording, hidden commands, error texts. */
export type AcpProfile = {
  name: string;
  capabilities: Capabilities;
  minVersion: string;
  command(): string;
  /** the launch flags of a mode (they go before the agent's own subcommand) */
  args(mode: AgentMode): string[];
  acpMode(mode: AgentMode): 'default' | 'plan';
  /** both modes run on the same launch flags: switching needs no new process */
  sameProcess(a: AgentMode, b: AgentMode): boolean;
  /** null for any form that is not a tool approval */
  approvalForm(message: string, schema: Record<string, unknown>): ApprovalForm | null;
  hideCommands: ReadonlySet<string>;
  beforeResume?(sessionId: string): Promise<void>;
  errors: { install: string; disconnected: string; auth: string; notFound: string; tooOld(version: string): string };
};

const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

export function acpBackend(profile: AcpProfile, options: { connect?: (mode: AgentMode, cwd?: string) => AcpConnection } = {}): AgentBackend {
  const connect = options.connect ?? ((mode: AgentMode, cwd?: string) => new AcpRpc({ name: profile.name, command: profile.command(), args: profile.args(mode), cwd, clientVersion: CLIENT_VERSION, installHint: profile.errors.install }));
  const first = profile.capabilities.modes[0]!;
  let metadata: AcpConnection | undefined;
  const sessions = new Set<AcpSession>();
  // the replay's connection: start() of the same session takes it over, so the conversation is loaded once, in one process
  type Preopened = { id: string; cwd: string; rpc: AcpConnection; configOptions: unknown; blocks: number; commands?: Record<string, unknown>; timer: NodeJS.Timeout };
  let preopened: Preopened | undefined;
  const rpc = () => {
    if (!metadata) { const connection = connect(first); metadata = connection; void connection.closed.then(() => { if (metadata === connection) metadata = undefined; }); }
    return metadata;
  };
  // omp pages `session/list` (newest first); a repeated cursor ends the walk
  const list = async (cwd?: string) => {
    const out: Record<string, unknown>[] = []; const seen = new Set<string>(); let cursor: string | undefined;
    do {
      const page = record(await rpc().request('session/list', { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) }));
      out.push(...array(page.sessions).map(record).filter((s) => string(s.sessionId)));
      cursor = string(page.nextCursor) || undefined;
      if (cursor && seen.has(cursor)) break;
      if (cursor) seen.add(cursor);
    } while (cursor && out.length < 1000);
    return out;
  };
  const take = (): Preopened | undefined => { const p = preopened; preopened = undefined; if (p) clearTimeout(p.timer); return p; };
  const drop = async () => { await take()?.rpc.close(); };
  return {
    capabilities: profile.capabilities, nativeSessions: true,
    start(o) {
      const pre = preopened && o.resume === preopened.id && real(o.cwd) === preopened.cwd ? take() : undefined;
      let s: AcpSession;
      if (pre && !o.fork) s = new AcpSession(o, profile, (mode) => connect(mode, o.cwd), { rpc: pre.rpc, mode: first, sessionId: pre.id, configOptions: pre.configOptions, blocks: pre.blocks, ...(pre.commands ? { commands: pre.commands } : {}) });
      else {
        // a fork goes on after the source's replay: its ids continue the count, and the replay's process is not needed
        void (pre ? pre.rpc.close() : drop());
        s = new AcpSession(o, profile, (mode) => connect(mode, o.cwd), undefined, pre?.blocks ?? 0);
      }
      sessions.add(s);
      void s.closed.then(() => sessions.delete(s));
      return s;
    },
    async close() { for (const s of sessions) s.close(); await drop(); await Promise.all([...sessions].map((s) => s.closed)); await metadata?.close(); },
    async listSessions() {
      return (await list()).map((s) => {
        const size = record(s._meta).size;
        return { sessionId: string(s.sessionId), cwd: string(s.cwd), customTitle: string(s.title) || undefined, lastModified: Date.parse(string(s.updatedAt)) || 0, ...(typeof size === 'number' ? { fileSize: size } : {}) };
      }).sort((a, b) => b.lastModified - a.lastModified);
    },
    async sessionInfo(id, dir) {
      const s = (await list(real(dir))).find((s) => s.sessionId === id);
      if (!s || real(string(s.cwd)) !== real(dir)) return null;
      return { cwd: string(s.cwd), customTitle: string(s.title) || undefined };
    },
    async renameSession() { throw new Error(`${profile.name} renames only the open conversation (use the session's own rename)`); },
    async history(id, cwd) {
      // a restart closes the old session and reads history at once: wait for its process to be gone
      await Promise.all([...sessions].filter((s) => s.sessionId === id).map((s) => s.closed));
      await drop();
      // a held lease is not refused here: a fork may read it, and a plain resume is refused when the session starts
      const leased = await profile.beforeResume?.(id).then(() => false, () => true) ?? false;
      const connection = connect(first, cwd);
      try {
        const { events, configOptions, blocks, commands } = await captureReplay(connection, id, cwd);
        if (leased) { void connection.close(); return events; }
        const pre: Preopened = { id, cwd: real(cwd), rpc: connection, configOptions, blocks, ...(commands ? { commands } : {}), timer: setTimeout(() => { if (preopened === pre) void drop(); }, 60_000) };
        pre.timer.unref();
        // omp announces its commands shortly after `session/load` answers: keep the last announcement for the session
        connection.onNotification((method, p) => {
          const u = record(p.update);
          if (method === 'session/update' && p.sessionId === id && u.sessionUpdate === 'available_commands_update') pre.commands = u;
        });
        preopened = pre;
        return events;
      } catch (e) {
        void connection.close();
        if (e instanceof AcpError && /session not found/i.test(string(record(e.data).details))) throw new Error(profile.errors.notFound);
        throw e;
      }
    },
    async subagent() { return null; },
  };
}
