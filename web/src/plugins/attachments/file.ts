import { routes, send } from '@/sdk';

/** A refused upload: the HTTP status and the server's error code (`attachments-not-folder`, ...). */
export class UploadError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined) {
    super(code ?? String(status));
    this.status = status;
    this.code = code;
  }
}

/**
 * Any file that is not an image (issue 461): streamed to the server (the File itself is the body, never read into memory)
 * into the project's `attachments/`; answers the project-relative path it got there. `signal` cancels it.
 */
export async function uploadFile(f: File, signal?: AbortSignal): Promise<string> {
  const r = await send(routes.attachFile(f.name), f, signal ? { signal } : {});
  const j = (await r.json().catch(() => null)) as { path?: unknown; error?: unknown } | null;
  if (!r.ok || typeof j?.path !== 'string') throw new UploadError(r.status, typeof j?.error === 'string' ? j.error : undefined);
  return j.path;
}
