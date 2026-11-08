import { execFile } from 'node:child_process';
import { OMP_MODES, type AgentMode, type Capabilities } from '@nota-bene/shared';
import { array, record } from '../json.ts';
import { acpBackend, type AcpProfile, type ApprovalForm } from './backend.ts';
import { OMP_MIN_VERSION } from '../versions.ts';

export { OMP_MIN_VERSION };
export const OMP_CAPABILITIES: Capabilities = {
  provider: 'omp', compact: false, clear: true, fork: true, usage: true, fileSuggestions: false, idleCompact: false, models: true,
  modes: [...OMP_MODES], taskBackground: false, taskOutput: false, suggestions: false,
};
/** omp's `--approval-mode` per mode; plan is an ACP mode on top of always-ask */
const APPROVAL: Partial<Record<AgentMode, string>> = { 'omp-yolo': 'yolo', 'omp-write': 'write', 'omp-ask': 'always-ask', 'omp-plan': 'always-ask' };
/** omp commands that drive its TUI, or that Nota Bene's own controls already cover */
export const OMP_HIDDEN_COMMANDS: ReadonlySet<string> = new Set(['security', 'model', 'models', 'switch', 'fast', 'slow', 'skillful', 'extended-context', 'computer', 'ratchet', 'prewalk', 'modelpreset', 'effort', 'advisor', 'export', 'trace', 'dump', 'share', 'browser', 'todo', 'session', 'jobs', 'usage', 'stats', 'changelog', 'tools', 'context', 'mcp', 'ssh', 'fresh', 'shake', 'pin', 'retry', 'memory', 'rename', 'move', 'wt', 'worktree', 'add-dir', 'remove-dir', 'dirs', 'marketplace', 'plugins', 'plugin', 'reload-plugins', 'force', 'force:', 'forget-approvals', 'init']);

const command = () => process.env.NOTA_BENE_OMP ?? 'omp';

/** omp asks for a tool approval as a one-field form: `Allow tool: <name>\n<details>` with an enum of answers. */
export function approvalForm(message: string, schema: Record<string, unknown>): ApprovalForm | null {
  const m = /^Allow tool: (\S+)/.exec(message), props = Object.entries(record(schema.properties));
  if (!m || props.length !== 1) return null;
  const [property, raw] = props[0]!, values = array(record(raw).enum).filter((v): v is string => typeof v === 'string');
  if (!values.length) return null;
  const nl = message.indexOf('\n');
  return {
    tool: m[1]!, title: nl < 0 ? message : message.slice(0, nl), details: nl < 0 ? '' : message.slice(nl + 1).trim(), property,
    choices: values.map((v) => ({ id: v, label: v, allow: !/^(deny|reject|cancel)/i.test(v) })),
  };
}

/** Refuses a conversation another omp process holds. An omp without `session lease` (or any failure) lets it through. */
async function assertNotLeased(id: string): Promise<void> {
  const held = await new Promise<unknown[]>((resolve) => {
    execFile(command(), ['session', 'lease', '--json', '--', id], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve([]);
      try { resolve(array(record(JSON.parse(stdout)).held)); } catch { resolve([]); }
    });
  });
  if (held.includes(id)) throw new Error('This omp conversation is open in another omp process. Close it there, or start a new conversation here.');
}

export const OMP: AcpProfile = {
  name: 'omp', capabilities: OMP_CAPABILITIES, minVersion: OMP_MIN_VERSION, command,
  // launch flags go before `acp`: after it omp ignores them
  args: (mode) => ['--approval-mode', APPROVAL[mode] ?? 'yolo', 'acp'],
  acpMode: (mode) => mode === 'omp-plan' ? 'plan' : 'default',
  sameProcess: (a, b) => (APPROVAL[a] ?? 'yolo') === (APPROVAL[b] ?? 'yolo'),
  approvalForm, hideCommands: OMP_HIDDEN_COMMANDS, beforeResume: assertNotLeased,
  errors: {
    install: ' Install omp (https://omp.sh) or set NOTA_BENE_OMP.',
    disconnected: 'omp disconnected. Restart the session to retry.',
    auth: 'omp has no credentials for this model: sign in from a terminal (omp login), then send again.',
    notFound: 'omp conversation not found',
    tooOld: (v) => `omp ${v} is too old: Nota Bene needs ${OMP_MIN_VERSION} or newer. Update omp, then restart this session.`,
  },
};

export const ompBackend = () => acpBackend(OMP);
