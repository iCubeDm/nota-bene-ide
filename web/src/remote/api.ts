import type { RemoteState } from '@nota-bene/shared';
import { apiFetch } from '@/net/auth.ts';

export type PairCode = { uri: string; qr: string; hostFingerprint: string; expiresAt: number };

/** A refusal of a /remote route: the server's `error` (a bad relay address says what is wrong with it). */
export class RemoteError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await apiFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new RemoteError(r.status, j.error ?? `HTTP ${r.status}`);
  return j as T;
}

export const saveRemote = (c: { relay?: string; enabled?: boolean }) => post<{ state: RemoteState; stopped: 'hand' | 'managed' | null }>('/remote/config', c);
export const startPair = () => post<PairCode>('/remote/pair');
export const cancelPair = () => post<{ ok: true }>('/remote/pair/cancel');
export const revokePhone = (id: string) => post<{ ok: boolean; error?: string }>('/remote/revoke', { id });
