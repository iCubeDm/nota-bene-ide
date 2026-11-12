import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** what Nota Bene says it is in `initialize`; the release pin test keeps it at package.json's version */
export const CLIENT_VERSION = '1.8.0';

export class AcpError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  constructor(message: string, code?: number, data?: unknown) { super(message); this.code = code; this.data = data; }
}

export type AcpRequest = { id: string | number; method: string; params: Record<string, unknown> };

export interface AcpConnection {
  /** the `initialize` result */
  readonly ready: Promise<Record<string, unknown>>;
  readonly closed: Promise<void>;
  request(method: string, params?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): () => void;
  onRequest(handler: (request: AcpRequest, signal: AbortSignal) => Promise<unknown>): void;
  close(): Promise<void>;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; dispose(): void };
export type AcpRpcOptions = { name: string; command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; clientVersion: string; installHint?: string; timeoutMs?: number; maxFrameBytes?: number };

/** An owned ACP agent process speaking JSON-RPC 2.0, one frame per line, on stdio. */
export class AcpRpc implements AcpConnection {
  readonly ready: Promise<Record<string, unknown>>;
  readonly closed: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly asks = new Map<string | number, AbortController>();
  private readonly notifications = new Set<(method: string, params: Record<string, unknown>) => void>();
  private handler: ((request: AcpRequest, signal: AbortSignal) => Promise<unknown>) | undefined;
  private ended: Error | undefined;
  private nextId = 0;
  private text = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly options: AcpRpcOptions;
  private readonly name: string;
  private closeResolve!: () => void;
  private killTimer: NodeJS.Timeout | undefined;

  constructor(options: AcpRpcOptions) {
    this.options = options; this.name = options.name;
    this.closed = new Promise((resolve) => { this.closeResolve = resolve; });
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    this.child.stdout.on('data', (data: Buffer) => this.receive(data));
    // the agent prints a banner and diagnostics there; never forward them
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.fail(new Error(`${this.name} input stream closed`)));
    this.child.on('error', (e: NodeJS.ErrnoException) => this.fail(new Error(`Cannot start ${this.name} (${e.code ?? 'spawn error'}).${options.installHint ?? ''}`)));
    this.child.on('exit', (code, signal) => this.fail(new Error(`${this.name} exited (${signal ?? code ?? 'unknown'})`)));
    this.child.on('close', () => {
      // the leader may exit while a tool descendant ignores TERM: retire the owned group before resolving close
      if (process.platform !== 'win32' && this.child.pid) { try { process.kill(-this.child.pid, 'SIGKILL'); } catch { /* group already gone */ } }
      clearTimeout(this.killTimer); this.closeResolve();
    });
    this.ready = this.call('initialize', {
      protocolVersion: 1,
      // without elicitation.form the agent denies every approval it asks for as a form
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
      clientInfo: { name: 'nota-bene', title: 'Nota Bene', version: options.clientVersion },
    }).then((info) => (info && typeof info === 'object' && !Array.isArray(info) ? info as Record<string, unknown> : {}));
    void this.ready.catch(() => {}); // ready may reject before the first caller subscribes
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): () => void {
    this.notifications.add(handler);
    return () => { this.notifications.delete(handler); };
  }

  onRequest(handler: (request: AcpRequest, signal: AbortSignal) => Promise<unknown>): void {
    this.handler = handler;
  }

  /** `timeoutMs: 0`: no timeout (a prompt runs as long as the agent works) */
  async request(method: string, params: unknown = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    if (options.signal) {
      const signal = options.signal;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new Error(`${this.name} request aborted`)); };
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        this.ready.then(() => { signal.removeEventListener('abort', abort); resolve(); }, (e) => { signal.removeEventListener('abort', abort); reject(e); });
      });
    } else await this.ready;
    return await this.call(method, params, options);
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  private call(method: string, params: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    if (this.ended) return Promise.reject(this.ended);
    if (options.signal?.aborted) return Promise.reject(new Error(`${this.name} request aborted`));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const remove = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); this.pending.delete(id); };
      const abort = () => { remove(); reject(new Error(`${this.name} request aborted`)); };
      const ms = options.timeoutMs ?? this.options.timeoutMs ?? 30_000;
      const timer = ms > 0 ? setTimeout(() => { remove(); reject(new Error(`${this.name} ${method} timed out`)); }, ms) : undefined;
      timer?.unref();
      options.signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, dispose: remove });
      try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (error) { remove(); reject(error); }
    });
  }

  private write(frame: unknown): void {
    if (this.ended) throw this.ended;
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }

  // a manual split: readline also breaks lines at U+2028/U+2029, which JSON strings may carry
  private receive(data: Buffer): void {
    if (this.ended) return;
    this.text += this.decoder.write(data);
    const max = this.options.maxFrameBytes ?? 32 * 1024 * 1024;
    for (;;) {
      const newline = this.text.indexOf('\n');
      if (newline < 0) break;
      const line = this.text.slice(0, newline);
      this.text = this.text.slice(newline + 1);
      if (Buffer.byteLength(line) > max) return this.fail(new Error(`${this.name} frame exceeds size limit`));
      if (!line.trim()) continue;
      try { this.frame(JSON.parse(line)); } catch { return this.fail(new Error(`Invalid ${this.name} JSON frame`)); }
    }
    if (Buffer.byteLength(this.text) > max) this.fail(new Error(`${this.name} frame exceeds size limit`));
  }

  private frame(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid frame');
    const frame = value as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown; code?: unknown; data?: unknown } };
    if (typeof frame.method === 'string') {
      const params = frame.params && typeof frame.params === 'object' ? frame.params as Record<string, unknown> : {};
      if (typeof frame.id === 'number' || typeof frame.id === 'string') void this.answer({ id: frame.id, method: frame.method, params });
      else for (const handler of this.notifications) handler(frame.method, params);
      return;
    }
    if (typeof frame.id !== 'number') throw new Error('invalid response id');
    const waiting = this.pending.get(frame.id);
    if (!waiting) return; // late response after timeout/abort
    waiting.dispose();
    if (frame.error) waiting.reject(new AcpError(typeof frame.error.message === 'string' ? frame.error.message : `${this.name} request failed`, typeof frame.error.code === 'number' ? frame.error.code : undefined, frame.error.data));
    else if ('result' in frame) waiting.resolve(frame.result);
    else waiting.reject(new Error(`Invalid ${this.name} JSON response`));
  }

  private async answer(request: AcpRequest): Promise<void> {
    const controller = new AbortController();
    this.asks.set(request.id, controller);
    let response: unknown;
    if (!this.handler) response = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
    else {
      try {
        response = { jsonrpc: '2.0', id: request.id, result: await this.handler(request, controller.signal) };
      } catch (error) {
        response = { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : 'Request failed' } };
      }
    }
    if (!this.ended) { try { this.write(response); } catch { /* the agent is gone */ } }
    this.asks.delete(request.id);
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = error;
    for (const waiting of [...this.pending.values()]) { waiting.dispose(); waiting.reject(error); }
    for (const controller of this.asks.values()) controller.abort();
    this.asks.clear();
    this.stop();
  }

  private stop(): void {
    const signal = (name: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, name);
        else this.child.kill(name);
      } catch { /* already exited */ }
    };
    signal('SIGTERM');
    if (!this.killTimer) { this.killTimer = setTimeout(() => signal('SIGKILL'), 1000); this.killTimer.unref(); }
  }

  async close(): Promise<void> {
    this.fail(new Error(`${this.name} connection closed`));
    await this.closed;
  }
}
