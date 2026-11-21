import type { RemoteHost, RemoteRefusalCode, RemoteState } from '@nota-bene/shared';
import { connections } from '@/sdk';

export type PairCode = { uri: string; qr: string; hostFingerprint: string; expiresAt: number };

/** A refusal of a /remote route: the server's `error`, and its `code` and `detail` when it is a known one (issue 507). */
export class RemoteError extends Error {
  readonly status: number;
  readonly code: RemoteRefusalCode | undefined;
  readonly detail: string | undefined;
  constructor(status: number, message: string, code?: RemoteRefusalCode, detail?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await connections.current().fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const j = (await r.json().catch(() => ({}))) as { error?: string; code?: RemoteRefusalCode; detail?: string };
  if (!r.ok) throw new RemoteError(r.status, j.error ?? `HTTP ${r.status}`, j.code, j.detail);
  return j as T;
}

export const saveRemote = (c: { relay?: string; enabled?: boolean; accessKey?: string | null }) => post<{ state: RemoteState; stopped: 'hand' | 'managed' | null }>('/remote/config', c);
export const startPair = () => post<PairCode>('/remote/pair');
export const cancelPair = () => post<{ ok: true }>('/remote/pair/cancel');
export const revokePhone = (id: string) => post<{ ok: boolean; error?: string }>('/remote/revoke', { id });
export const connectComputer = (code: string) => post<{ ok: true; host: RemoteHost }>('/remote/connect', { code });
export const forgetComputer = (id: string) => post<{ ok: boolean; error?: string }>('/remote/forget', { id });
