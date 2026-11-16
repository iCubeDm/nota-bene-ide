import { useId, useMemo } from 'react';
import { validateCut, type CutIssue } from '@nota-bene/shared/cut';
import { useT } from '@/i18n/index.ts';
import { drawable } from './layout.ts';
import { ExportControl } from './export/ExportControl.tsx';
import { Timeline } from './Timeline.tsx';
import { useMissing } from './useMissing.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clipIndex = (path: string) => /^clips\[(\d+)\]/.exec(path)?.[1];

/**
 * A `*.nbcut.json` file as its timeline (read-only, #407). Whatever is wrong in it (not JSON, a validation problem, a
 * source not in the project) is listed above the timeline, which still draws what it can; the header's Source shows the
 * JSON. `path` (the edit's, project-relative) is given for an edit of the session's project: the toolbar then has Export
 * (#411), disabled while anything is wrong in the edit, since the server would refuse it.
 */
export function CutBody({ text, src, path, tabId, active }: { text: string; src: string; path?: string; tabId: string; active: boolean }) {
  const t = useT();
  const listId = useId();
  const parsed = useMemo((): { v: unknown } | { error: string } => {
    try {
      return { v: JSON.parse(text) as unknown };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [text]);
  const v = 'v' in parsed ? parsed.v : undefined;
  const check = useMemo(() => validateCut(v), [v]);
  const draw = useMemo(() => drawable(v), [v]);
  // every clip's source, placed or not: a missing file is worth knowing either way
  const clips = isObj(v) && Array.isArray(v.clips) ? v.clips : [];
  const srcs = clips.flatMap((c: unknown) => (isObj(c) && typeof c.src === 'string' && c.src ? [c.src] : []));
  const missing = useMissing('v' in parsed ? srcs : [], src, active);

  const issues: CutIssue[] = [...(check.ok ? [] : check.errors)];
  clips.forEach((c: unknown, i) => {
    if (isObj(c) && typeof c.src === 'string' && missing.has(c.src)) {
      issues.push({ path: `clips[${i}].src`, code: 'missing', ...(typeof c.id === 'string' && { clip: c.id }) });
    }
  });
  const problems = new Map<number, string[]>();
  for (const x of issues) {
    const i = clipIndex(x.path);
    if (i !== undefined) problems.set(Number(i), [...(problems.get(Number(i)) ?? []), `${x.path}: ${t('cutIssue', x.code)}`]);
  }
  const frame = isObj(v) && [v.width, v.height, v.fps].every((n) => typeof n === 'number' && n > 0)
    ? { width: v.width as number, height: v.height as number, fps: v.fps as number }
    : null;

  return (
    <div data-pane={tabId} hidden={!active} className="relative min-h-0 flex-1 flex-col bg-background [&:not([hidden])]:flex">
      {'error' in parsed ? (
        <p className="p-4 text-sm text-destructive">{t('cutBadJson', parsed.error)}</p>
      ) : (
        <>
          {issues.length > 0 && (
            <div className="max-h-40 flex-none overflow-auto border-b border-border-soft px-3 py-2 text-xs">
              <p id={listId} className="mb-1 font-medium text-destructive">{t('cutProblems', issues.length)}</p>
              <ul aria-labelledby={listId} className="space-y-0.5">
                {issues.map((x, i) => (
                  <li key={i} className="text-muted-foreground">
                    {x.path && <code className="mr-1.5 font-mono text-foreground">{x.path}</code>}
                    {t('cutIssue', x.code)}
                    {x.clip !== undefined && ` · ${t('cutClipOf', x.clip)}`}
                    {x.clip === undefined && x.track !== undefined && ` · ${t('cutTrackOf', x.track)}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {draw.blocks.length === 0 && issues.length === 0 && (
            <p className="flex-none px-3 py-2 text-sm text-muted-foreground">{t('cutNoClips')}</p>
          )}
          {draw.lanes.length > 0 && (
            <Timeline
              lanes={draw.lanes} blocks={draw.blocks} end={draw.end} frame={frame} problems={problems} missing={missing} fileSrc={src} active={active}
              tools={path !== undefined && <ExportControl path={path} blocked={issues.length > 0 ? t('cutExportBlocked') : undefined} />}
            />
          )}
        </>
      )}
    </div>
  );
}
