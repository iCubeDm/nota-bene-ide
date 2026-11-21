import { connections, defineResource, routes } from '@/sdk';

/** The video editor's export (server/src/cut/routes.ts): an edit rendered by ffmpeg into the project's `exports/`. */
export type ExportMode = 'mp4' | 'wav' | 'm4a';
export const EXPORT_MODES: readonly ExportMode[] = ['mp4', 'wav', 'm4a'];

/** An edit's last export. `edit` and `output` are project-relative; `progress` is 0..1; `error`: ffmpeg's last lines. */
export type ExportJob = {
  edit: string;
  mode: ExportMode;
  phase: 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  output: string;
  error?: string;
};

/** `GET /cut/export`: ffmpeg is found (asked anew each time) and new enough, else why not (`old`: older than 4.4), and the edit's last export. */
type ExportState = { ffmpeg: boolean; ffmpegProblem?: 'old'; ffmpegVersion?: string; job: ExportJob | null };

/** The server refused a start: `code` as in server/src/cut/exporter.ts (`running`, `outside-project`, `missing-source`, ...). */
export class ExportRefused extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  constructor(status: number, code: string, detail: string) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function post(url: string, body: unknown): Promise<Response> {
  return connections.current().fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** `GET /cut/export` of an edit; a 404 is a server without the export routes (older than the capability). */
export const exportResource = defineResource<string, ExportState>({ id: 'cut.export', key: (edit) => edit, route: (edit) => routes.cutExport(edit) });

export async function startExport(edit: string, mode: ExportMode): Promise<ExportJob> {
  const r = await post(routes.cutExport(), { path: edit, mode });
  const j = (await r.json().catch(() => ({}))) as { job?: ExportJob; error?: string; detail?: string };
  if (!r.ok || !j.job) throw new ExportRefused(r.status, j.error ?? String(r.status), j.detail ?? '');
  return j.job;
}

/** False when no export of the edit was running. */
export async function cancelExport(edit: string): Promise<boolean> {
  return (await post(routes.cutExportCancel(), { path: edit })).ok;
}
