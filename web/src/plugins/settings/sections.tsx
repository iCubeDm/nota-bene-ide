import { UI_SCALES, type UiScale } from '@nota-bene/shared';
import { defineResource, routes, useResource, useSettings, storage, systemPrefs, byteSize, percent, getLang, chooseLang, LANGS, useT, type Lang, shortWinHome, selectCapabilitiesKnown, useAppSelector, theme, THEME_GROUPS, THEME_NAMES, useTheme, uiScale, useUiScale, playCue, type Sounds, type SettingsSection } from '@/sdk';
import { Button, SettingsFail, SettingsRow as Row } from '@/sdk/ui';

type Size = { bytes: number; files: number };
/** `history`: the archive before compactions (R-M7-1); absent from a server older than M7-12 */
type Storage = { attachments: Size; comments: Size; history?: Size; trash: Size; marks: Size & { root: string }; unreferenced: Size };
type About = { version: string; stateDir: string; logs: string[]; node: string; pid: number };

const storageResource = defineResource<void, Storage>({ id: 'settings.storage', key: () => '', route: () => routes.systemStorage() });
const aboutResource = defineResource<void, About>({ id: 'settings.about', key: () => '', route: () => routes.systemAbout() });
export const SETTINGS_RESOURCES = [storageResource, aboutResource];

// macOS and Linux home folders, and Windows' C:/Users/<name>
const short = (d: string) => shortWinHome(d).replace(/^\/(Users|home)\/[^/]+/, '~');
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
  { id: 'storage', order: 20, title: 'setStorage', render: StorageSection },
  { id: 'defaults', order: 40, title: 'setDefaults' },
  { id: 'lang', in: 'defaults', order: 10, render: LangRow },
  { id: 'scale', in: 'defaults', order: 20, render: ScaleRow },
  { id: 'audit', in: 'defaults', order: 60, render: AuditRow },
  { id: 'sounds', in: 'defaults', order: 80, render: SoundsRow },
  { id: 'themes', order: 50, title: 'setThemes', render: Themes },
  { id: 'about', order: 60, title: 'setAbout', render: AboutSection },
];
