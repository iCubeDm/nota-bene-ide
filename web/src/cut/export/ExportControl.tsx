import { useEffect, useRef, useState } from 'react';
import { useT, useAppDispatch, useAppSelector, openFile, useResource, selectCapabilitiesKnown } from '@/sdk';
import { Button } from '@/sdk/ui';
import { cancelExport, EXPORT_MODES, ExportRefused, exportResource, startExport, type ExportJob, type ExportMode } from './api.ts';

/** how often a running export is looked at */
const POLL_MS = 1000;

/** How to get ffmpeg, by system: commands, not translated. */
const INSTALL = [['macOS', 'brew install ffmpeg'], ['Windows', 'winget install ffmpeg'], ['Linux', 'sudo apt install ffmpeg']] as const;

/**
 * The Export control of an edit: a format (video, or the sound mix alone), Export, the progress with Cancel while it runs,
 * then the result as a link that opens the file in a tab, or what went wrong. Without ffmpeg on the host it says how to
 * install it. The server's live answer (`GET /cut/export`) wins over `hello.capabilities.ffmpeg`, so an ffmpeg installed
 * after the server started is found without a reconnect. Standalone: the timeline mounts it with the edit's path, and
 * `blocked` (why, as a tooltip) while the edit has problems: the format and Export are disabled then.
 */
export function ExportControl({ path, blocked, pollMs = POLL_MS }: { path: string; blocked?: string; pollMs?: number }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const capability = useAppSelector(selectCapabilitiesKnown)?.ffmpeg;
  const [live, setLive] = useState<boolean | null | undefined>(undefined); // null: a server without the routes
  const [oldVersion, setOldVersion] = useState<string | null>(null); // the ffmpeg found is older than 4.4
  const [job, setJob] = useState<ExportJob | null>(null);
  const [mode, setMode] = useState<ExportMode>('mp4');
  const [refusal, setRefusal] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const running = job?.phase === 'running';
  // the server's answer, applied when it says something new; a running export is looked at every pollMs
  const got = useResource(exportResource, path, { every: running ? pollMs : 0 });
  const gone = got.failed && got.status === 404;
  useEffect(() => {
    if (gone) return setLive(null);
    const s = got.data;
    if (!s) return;
    setLive(s.ffmpeg);
    setOldVersion(s.ffmpegProblem === 'old' ? s.ffmpegVersion ?? '?' : null);
    setJob(s.job);
  }, [got.data, gone]);
  const load = got.refresh;

  const ffmpeg = live === undefined ? capability : live === null ? undefined : live;
  const worded = (e: unknown): string => {
    if (!(e instanceof ExportRefused)) return e instanceof Error ? e.message : String(e);
    if (e.code === 'running') return t('cutExportBusy');
    if (e.code === 'outside-project') return t('cutExportOutside', e.detail);
    if (e.code === 'missing-source') return t('cutExportMissing', e.detail);
    if (e.code === 'invalid-edit') return t('cutExportInvalid', e.detail);
    if (e.code === 'unreadable-source') return t('cutExportUnreadable', e.detail);
    if (e.code === 'too-long') return t('cutExportTooLong', e.detail);
    if (e.code === 'not-an-edit') return t('cutExportNotEdit', e.detail);
    if (e.code === 'empty') return t('cutExportEmpty');
    if (e.code === 'bad-edit') return t('cutExportBadEdit', e.detail);
    if (e.code === 'no-edit') return t('cutExportNoEdit');
    if (e.code === 'closing') return t('cutExportClosing');
    if (e.code === 'output-busy') return t('cutExportOutputBusy', e.detail);
    if (e.code === 'internal') return t('cutExportServer', e.detail);
    if (e.code === 'no-ffmpeg') setLive(false);
    if (e.code === 'old-ffmpeg') {
      setLive(false);
      setOldVersion(e.detail || '?');
    }
    return e.message;
  };
  const start = async () => {
    setBusy(true);
    setRefusal('');
    try {
      const j = await startExport(path, mode);
      if (alive.current) setJob(j);
    } catch (e) {
      if (alive.current) setRefusal(worded(e));
    }
    if (alive.current) setBusy(false);
  };
  const cancel = async () => {
    await cancelExport(path).catch(() => false);
    load();
  };

  if (ffmpeg === undefined && live === null) return <p className="text-[0.8125rem] text-muted-foreground">{t('cutExportOld')}</p>;
  if (ffmpeg === false) {
    return (
      <div data-cut-export className="flex flex-col gap-1.5 text-[0.8125rem]">
        <p className="text-muted-foreground">{oldVersion ? t('cutExportOldFfmpeg', oldVersion) : t('cutExportNoFfmpeg')}</p>
        <ul className="flex flex-col gap-0.5">
          {INSTALL.map(([os, cmd]) => <li key={os}>{os}: <code className="select-all rounded bg-muted px-1 font-mono">{cmd}</code></li>)}
        </ul>
      </div>
    );
  }
  const pct = Math.round((job?.progress ?? 0) * 100);
  const label: Record<ExportMode, string> = { mp4: t('cutExportMp4'), wav: t('cutExportWav'), m4a: t('cutExportM4a') };
  return (
    <div data-cut-export className="flex flex-col gap-2 text-[0.8125rem]">
      <div className="flex items-center gap-2" title={running ? undefined : blocked}>
        <select
          aria-label={t('cutExportFormat')}
          className="h-8 rounded-md border border-input bg-background px-2"
          value={mode}
          disabled={running || blocked !== undefined}
          onChange={(e) => setMode(e.target.value as ExportMode)}
        >
          {EXPORT_MODES.map((m) => <option key={m} value={m}>{label[m]}</option>)}
        </select>
        <Button type="button" size="sm" disabled={running || busy || ffmpeg !== true || blocked !== undefined} onClick={() => void start()}>{t('cutExport')}</Button>
        {running && <Button type="button" size="sm" variant="outline" onClick={() => void cancel()}>{t('cutExportCancel')}</Button>}
      </div>
      {running && (
        <div className="flex items-center gap-2">
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1.5 w-40 overflow-hidden rounded bg-muted">
            <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-muted-foreground">{t('cutExportRunning', pct)}</span>
        </div>
      )}
      {job?.phase === 'done' && (
        <div>
          {t('cutExportDone')}{' '}
          <button type="button" className="text-primary underline underline-offset-2" onClick={() => dispatch(openFile(job.output))}>{job.output}</button>
        </div>
      )}
      {job?.phase === 'cancelled' && <div role="status" className="text-muted-foreground">{t('cutExportCancelled')}</div>}
      {refusal ? <div role="alert" className="text-warn">{t('cutExportFailed', refusal)}</div>
        : job?.phase === 'failed' && <div role="alert" className="whitespace-pre-wrap font-mono text-xs text-warn">{t('cutExportFailed', job.error ?? '')}</div>}
    </div>
  );
}
