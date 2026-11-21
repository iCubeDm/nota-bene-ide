import { useState } from 'react';
import { UI_SCALES, type UiScale } from '@nota-bene/shared';
import { defineResource, routes, useResource, useSettings, storage, systemPrefs, byteSize, percent, getLang, chooseLang, LANGS, t as tNow, useT, type Lang, folderName, shortWinHome, selectCapabilitiesKnown, useAppSelector, theme, THEME_GROUPS, THEME_NAMES, useTheme, uiScale, useUiScale, playCue, type Sounds, type SettingsSection, send } from '@/sdk';
import { Button, SettingsFail, SettingsRow as Row } from '@/sdk/ui';

type Size = { bytes: number; files: number };
/** `history`: the archive before compactions (R-M7-1); absent from a server older than M7-12 */
type Storage = { attachments: Size; comments: Size; history?: Size; trash: Size; marks: Size & { root: string }; unreferenced: Size };
type WindowRow = {
  port: number; root: string; pid: number; startedAt: number; current: boolean;
  state: 'live' | 'restarting' | 'silent' | 'stale';
  session: string | null; title: string | null; supervised: boolean; busy: boolean; clients: number;
  /** gh-422: a server restart waits for its agent; absent: a window of a version before that (its restart cuts the turn) */
  restartPending?: boolean;
};
type About = { version: string; stateDir: string; logs: string[]; node: string; pid: number };
type Action = 'restart-agent' | 'restart-server' | 'restart-server-now' | 'restart-server-cancel' | 'stop';

const windowsResource = defineResource<void, WindowRow[]>({ id: 'settings.windows', key: () => '', route: () => routes.systemWindows() });
const storageResource = defineResource<void, Storage>({ id: 'settings.storage', key: () => '', route: () => routes.systemStorage() });
const aboutResource = defineResource<void, About>({ id: 'settings.about', key: () => '', route: () => routes.systemAbout() });
export const SETTINGS_RESOURCES = [windowsResource, storageResource, aboutResource];

// macOS and Linux home folders, and Windows' C:/Users/<name>
const short = (d: string) => shortWinHome(d).replace(/^\/(Users|home)\/[^/]+/, '~');
const uptime = (since: number, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - since) / 60000));
  return m < 60 ? tNow('upMin', m) : m < 1440 ? tNow('upHMin', Math.floor(m / 60), m % 60) : tNow('upD', Math.floor(m / 1440));
};

function WindowsRefresh({ active }: { active: boolean }) {
  const t = useT();
  const windows = useResource(windowsResource, undefined, { on: active });
  return <Button type="button" variant="ghost" size="sm" onClick={windows.refresh}>{t('refresh')}</Button>;
}

/** Every Nota Bene window, with restart and stop for the others. */
function Windows({ active }: { active: boolean }) {
  const t = useT();
  const { note, ask } = useSettings();
  const windows = useResource(windowsResource, undefined, { on: active });
  // the port whose action is in flight: that row's buttons are off until it settles (no double relays)
  const [pending, setPending] = useState<number | null>(null);

  const act = (w: WindowRow, action: Action) => async () => {
    note(null);
    setPending(w.port);
    try {
      // the row's identity: the server refuses if another window has taken the port since this list was loaded; the
      // refusal's body says why, so this POST reads it itself rather than through the host's
      const r = await send(routes.systemWindowsAction(), { port: w.port, action, root: w.root, pid: w.pid, startedAt: w.startedAt }).catch(() => null);
      if (r?.ok) return note(t('winSent'));
      const body = r ? await r.text().catch(() => '') : '';
      const inner = r?.status === 502 ? (JSON.parse(body || '{}') as { status?: number }).status : undefined;
      note(!r ? t('setLoadFail', 'network')
        : body === 'window changed' ? t('winChanged')
        : inner === 403 || inner === 404 ? t('winOld') // a window started before the control route existed
        : t('setLoadFail', inner ? `${r.status} (${inner})` : `${r.status} ${body}`.trim()));
    } catch (e) {
      note(t('setLoadFail', e instanceof Error ? e.message : String(e)));
    } finally {
      setTimeout(() => { setPending(null); windows.refresh(); }, action === 'restart-agent' ? 500 : 1500);
    }
  };
  // every action on another window ends its running turn: ask first when it is working, and always for Stop
  // a restart of a window that waits for its agent cuts nothing: it goes without asking (gh-422); Restart now always asks
  const confirmAct = (w: WindowRow, action: Action, label: string) => {
    if (action === 'restart-server-cancel' || (action === 'restart-server' && w.restartPending !== undefined)) return void act(w, action)();
    if (action === 'restart-server-now') return ask({ title: label, body: t('winRestartNowQ', w.port, short(w.root)), confirm: t('restartNowBtn'), run: act(w, action) });
    if (action !== 'stop' && !w.busy) return void act(w, action)();
    const body = action === 'stop' ? t('winStopQ', w.port, short(w.root)) : t('winBusyQ', label, w.port, short(w.root));
    ask({ title: label, body: w.busy && action === 'stop' ? `${body}\n${t('winBusyNote')}` : body, confirm: label, run: act(w, action) });
  };

  return (
    <>
      <SettingsFail error={windows.failed ? windows.error : null} />
      {windows.data && !windows.data.length && <div className="text-xs text-muted-foreground">{t('winNone')}</div>}
      <div className="flex flex-col gap-2">
        {windows.data?.map((w) => (
          <div key={w.port} data-window={w.port} className="rounded-lg border border-border-soft px-3 py-2 text-[0.8125rem]">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-semibold text-foreground">{folderName(w.root) || w.root}</span>
              <span className="font-mono text-[0.6875rem] text-muted-foreground">{short(w.root)}</span>
              <span className="font-mono text-[0.6875rem] text-muted-foreground">:{w.port}</span>
              {w.current && <span className="rounded bg-primary/15 px-1.5 text-[0.6875rem] text-link">{t('winThis')}</span>}
              {w.state !== 'live' && <span className="text-[0.6875rem] text-warn">{t(`win_${w.state}`)}</span>}
            </div>
            {w.state === 'live' && (
              <div className="mt-0.5 text-xs text-muted-foreground">
                {[w.title, w.busy ? t('winBusy') : t('winIdle'), w.restartPending ? t('winRestartPending') : null, w.clients ? t('winTabs', w.clients) : t('winHeadless'), t('winUp', uptime(w.startedAt))].filter(Boolean).join(' · ')}
              </div>
            )}
            {!w.current && w.state === 'live' && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button asChild variant="outline" size="sm"><a href={`http://127.0.0.1:${w.port}/`} target="_blank" rel="noopener noreferrer">{t('winOpen')}</a></Button>
                <Button type="button" variant="outline" size="sm" disabled={pending === w.port} onClick={() => confirmAct(w, 'restart-agent', t('winRestartAgent'))}>{t('winRestartAgent')}</Button>
                {w.supervised && !w.restartPending && <Button type="button" variant="outline" size="sm" disabled={pending === w.port} onClick={() => confirmAct(w, 'restart-server', t('winRestartServer'))}>{t('winRestartServer')}</Button>}
                {w.supervised && w.restartPending && (
                  <>
                    <Button type="button" variant="outline" size="sm" disabled={pending === w.port} onClick={() => confirmAct(w, 'restart-server-now', t('restartServerNow'))}>{t('restartServerNow')}</Button>
                    <Button type="button" variant="outline" size="sm" disabled={pending === w.port} onClick={() => confirmAct(w, 'restart-server-cancel', t('restartCancel'))}>{t('restartCancel')}</Button>
                  </>
                )}
                <Button type="button" variant="outline" size="sm" disabled={pending === w.port} onClick={() => confirmAct(w, 'stop', t('winStop'))}>{t('winStop')}</Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** Sizes; moving unreferenced pasted images to the trash. */
function StorageSection({ active }: { active: boolean }) {
  const t = useT();
  const { post, note, ask } = useSettings();
  const storage = useResource(storageResource, undefined, { on: active });
  const clean = async () => {
    const r = await post(routes.systemStorageClean());
    try {
      if (r) {
        const j = (await r.json()) as { moved: number; bytes: number; trash: string; errors?: string[] };
        note(t('stCleaned', j.moved, byteSize(j.bytes), short(j.trash)) + (j.errors?.length ? ` · ${t('stErrors', j.errors.length, j.errors[0]!)}` : ''));
      }
    } catch (e) {
      note(t('setLoadFail', e instanceof Error ? e.message : String(e)));
    }
    storage.refresh();
  };
  const d = storage.data;
  return (
    <>
      <SettingsFail error={storage.failed ? storage.error : null} />
      {d && (
        <>
          <Row label={t('stAttachments')}>{byteSize(d.attachments.bytes)} · {t('stFiles', d.attachments.files)}</Row>
          <Row label={t('stComments')}>{byteSize(d.comments.bytes)} · {t('stFiles', d.comments.files)}</Row>
          {d.history && <Row label={t('stHistory')}>{byteSize(d.history.bytes)} · {t('stFiles', d.history.files)}</Row>}
          <Row label={t('stMarks')}>{byteSize(d.marks.bytes)} · {t('stFiles', d.marks.files)}</Row>
          <Row label={t('stTrash')}>{byteSize(d.trash.bytes)} · {t('stFiles', d.trash.files)}</Row>
          <div className="mt-3">
            {d.unreferenced.files ? (
              <Button type="button" variant="outline" size="sm"
                onClick={() => ask({ title: t('stClean'), body: t('stCleanQ', d.unreferenced.files, byteSize(d.unreferenced.bytes)), confirm: t('stClean'), run: clean })}>
                {t('stClean')} · {d.unreferenced.files}
              </Button>
            ) : <span className="text-xs text-muted-foreground">{t('stNothing')}</span>}
          </div>
        </>
      )}
    </>
  );
}

function LangRow() {
  const t = useT();
  return (
    <Row label={t('defLang')}>
      <select aria-label={t('defLang')} value={getLang()} onChange={(e) => chooseLang(e.target.value as Lang)}
        className="rounded-md border border-border-soft bg-transparent px-2 py-1 text-[0.8125rem] text-foreground">
        {LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </Row>
  );
}

function ScaleRow() {
  const t = useT();
  const scale = useUiScale();
  return (
    <Row label={t('defScale')}>
      <select aria-label={t('defScale')} value={scale} onChange={(e) => uiScale.choose(Number(e.target.value) as UiScale)}
        className="rounded-md border border-border-soft bg-transparent px-2 py-1 text-[0.8125rem] text-foreground">
        {UI_SCALES.map((v) => <option key={v} value={v}>{percent(v)}</option>)}
      </select>
    </Row>
  );
}

function AuditRow({ active }: { active: boolean }) {
  const t = useT();
  const { post } = useSettings();
  const prefs = useResource(systemPrefs, undefined, { on: active });
  return (
    <Row label={t('defAudit')}>
      {prefs.data && (
        <span className="flex flex-col gap-1">
          <input type="checkbox" aria-label={t('defAudit')} checked={prefs.data.audit !== false}
            onChange={(e) => void post(routes.systemPrefs(), { audit: e.target.checked }).then(prefs.refresh)}
            className="size-3.5 accent-primary" />
          {prefs.data.auditDir && <span className="text-xs text-muted-foreground">{t('defAuditHint', prefs.data.auditDir)}</span>}
        </span>
      )}
    </Row>
  );
}

function SoundsRow({ active }: { active: boolean }) {
  const t = useT();
  const { note } = useSettings();
  const prefs = useResource(systemPrefs, undefined, { on: active });
  const sounds = prefs.data?.sounds;
  const save = async (v: Sounds) => {
    const why = await storage.pref('sounds').set(v);
    if (why !== null) note(t('setLoadFail', why));
    prefs.refresh();
  };
  return (
    <Row label={t('defSounds')}>
      {sounds && (
        <span className="flex flex-col gap-1">
          {(['ask', 'done'] as const).map((k) => (
            <span key={k} className="flex items-center gap-1">
              <label className="flex items-center gap-2 text-[0.8125rem] text-foreground">
                <input type="checkbox" checked={sounds[k]} onChange={(e) => void save({ ...sounds, [k]: e.target.checked })} className="size-3.5 accent-primary" />
                {t(k === 'ask' ? 'defSoundAsk' : 'defSoundDone')}
              </label>
              <button type="button" onClick={() => playCue(k)} title={t('defSoundTry')} aria-label={`${t('defSoundTry')}: ${t(k === 'ask' ? 'defSoundAsk' : 'defSoundDone')}`}
                className="grid size-5 place-items-center rounded text-[0.625rem] text-muted-foreground hover:bg-muted hover:text-foreground">▶</button>
            </span>
          ))}
          <span className="text-xs text-muted-foreground">{t('defSoundsHint')}</span>
        </span>
      )}
    </Row>
  );
}

function Themes() {
  const t = useT();
  const themeId = useTheme();
  return (
    <div role="radiogroup" aria-label={t('setThemes')} className="flex flex-col gap-3">
      {THEME_GROUPS.map((g) => (
        <div key={g.kind} role="presentation" className="flex w-full flex-col gap-2">
          <h3 data-theme-heading className="text-xs font-semibold text-muted-foreground">{t(g.head)}</h3>
          <div role="presentation" className="flex flex-wrap gap-3">
            {g.ids.map((id) => (
              <button key={id} type="button" role="radio" aria-checked={themeId === id} onClick={() => theme.choose(id)}
                className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-[0.8125rem] text-foreground hover:bg-muted ${themeId === id ? 'border-primary' : 'border-border-soft'}`}>
                {/* data-theme re-scopes the tokens: the swatch shows this theme's colours, not the current one's */}
                <span data-theme={id} className="flex overflow-hidden rounded border border-border-soft" aria-hidden>
                  {['--background', '--card', '--primary'].map((v) => <span key={v} data-swatch={v} className="size-4" style={{ backgroundColor: `var(${v})` }} />)}
                </span>
                {THEME_NAMES[id]}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AboutSection({ active }: { active: boolean }) {
  const t = useT();
  const capabilities = useAppSelector(selectCapabilitiesKnown);
  const about = useResource(aboutResource, undefined, { on: active });
  const d = about.data;
  return (
    <>
      <SettingsFail error={about.failed ? about.error : null} />
      {d && (
        <>
          <Row label={t('aboutVersion')}><span className="font-mono text-xs">{d.version}</span></Row>
          <Row label={t('aboutState')}><span className="font-mono text-xs">{short(d.stateDir)}</span></Row>
          <Row label={t('aboutLogs')}>{d.logs.length ? <span className="font-mono text-xs">{d.logs.map(short).join(', ')}</span> : <span className="text-xs text-muted-foreground">{t(capabilities?.provider === 'codex' ? 'aboutNoLogsCodex' : capabilities?.provider === 'omp' ? 'aboutNoLogsOmp' : 'aboutNoLogs')}</span>}</Row>
          <Row label={t('aboutNode')}><span className="font-mono text-xs">{d.node} · pid {d.pid}</span></Row>
        </>
      )}
    </>
  );
}

/**
 * The Settings tab's own parts. Dictation (30) is the voice plugin's; the Defaults rows interleave with the controls'
 * mode (30), the update's two (40, 50), the projects' rail (70) and the composer's shell of `! cmd` (90).
 */
export const SETTINGS: SettingsSection[] = [
  { id: 'windows', order: 10, title: 'setWindows', render: Windows, aside: WindowsRefresh },
  { id: 'storage', order: 20, title: 'setStorage', render: StorageSection },
  { id: 'defaults', order: 40, title: 'setDefaults' },
  { id: 'lang', in: 'defaults', order: 10, render: LangRow },
  { id: 'scale', in: 'defaults', order: 20, render: ScaleRow },
  { id: 'audit', in: 'defaults', order: 60, render: AuditRow },
  { id: 'sounds', in: 'defaults', order: 80, render: SoundsRow },
  { id: 'themes', order: 50, title: 'setThemes', render: Themes },
  { id: 'about', order: 60, title: 'setAbout', render: AboutSection },
];
