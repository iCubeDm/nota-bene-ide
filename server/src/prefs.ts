import fs from 'node:fs';
import path from 'node:path';
import { EFFORT_LEVELS, ALL_MODES, isThemeId, isUiLang, isUiScale } from '@nota-bene/shared';
import type { AgentEffort as EffortLevel, AgentMode as Mode, ModelChoice, ThemeId, UiLang, UiScale } from '@nota-bene/shared';
import { stateDir } from './state.ts';

/** `idleCompact[root]`: idle compaction per project dir; absent = on (the default) */
/** `defaultMode`: the mode of a project with no entry in `modes` (Settings → Defaults; absent = auto) */
/** `updateCheck`: asking npm for a newer version (Settings → Defaults; absent = on) */
/** `audit`: the audit log of system events (Settings → Defaults; absent = on) */
/** `models[root]`: the model (and effort) a project's next session starts with; absent = the agent's default */
export type Prefs = { modes: Record<string, Mode>; models: Record<string, ModelChoice>; lang?: UiLang; uiScale?: UiScale; theme?: ThemeId; idleCompact: Record<string, boolean>; defaultMode?: Mode; updateCheck?: boolean; audit?: boolean; whisper?: boolean };

const isEffort = (v: unknown): v is EffortLevel => (EFFORT_LEVELS as readonly unknown[]).includes(v);
const isMode = (v: unknown): v is Mode => (ALL_MODES as readonly unknown[]).includes(v);
let reported = false; // a broken file is reported once per process, not on every read

/** Keys are real project dirs, so a symlinked path and its target share one setting. */
export function prefsKey(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

function file(): string {
  return path.join(stateDir(), 'prefs.json');
}

/** A missing or corrupt file gives the defaults; corruption is logged once. */
export function readPrefs(): Prefs {
  let raw: string;
  try {
    raw = fs.readFileSync(file(), 'utf8');
  } catch {
    return { modes: {}, models: {}, idleCompact: {} };
  }
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('prefs.json is not an object');
    const { modes, models, lang, uiScale, theme, idleCompact, defaultMode, updateCheck, audit, whisper } = data as { modes?: unknown; models?: unknown; lang?: unknown; uiScale?: unknown; theme?: unknown; idleCompact?: unknown; defaultMode?: unknown; updateCheck?: unknown; audit?: unknown; whisper?: unknown };
    const out: Prefs = { modes: {}, models: {}, idleCompact: {} };
    if (modes && typeof modes === 'object' && !Array.isArray(modes)) {
      for (const [k, v] of Object.entries(modes)) if (isMode(v)) out.modes[k] = v;
    }
    if (models && typeof models === 'object' && !Array.isArray(models)) {
      for (const [k, v] of Object.entries(models)) {
        const c = v as { model?: unknown; effort?: unknown } | null;
        if (c && typeof c === 'object' && typeof c.model === 'string' && c.model) {
          out.models[k] = { model: c.model, ...(isEffort(c.effort) ? { effort: c.effort } : {}) };
        }
      }
    }
    if (idleCompact && typeof idleCompact === 'object' && !Array.isArray(idleCompact)) {
      for (const [k, v] of Object.entries(idleCompact)) if (typeof v === 'boolean') out.idleCompact[k] = v;
    }
    if (isUiLang(lang)) out.lang = lang;
    if (isUiScale(uiScale)) out.uiScale = uiScale;
    if (isThemeId(theme)) out.theme = theme;
    if (isMode(defaultMode)) out.defaultMode = defaultMode;
    if (typeof updateCheck === 'boolean') out.updateCheck = updateCheck;
    if (typeof audit === 'boolean') out.audit = audit;
    if (typeof whisper === 'boolean') out.whisper = whisper;
    return out;
  } catch (e) {
    if (!reported) {
      reported = true;
      console.error('[prefs] ignoring unreadable prefs.json:', e);
    }
    return { modes: {}, models: {}, idleCompact: {} };
  }
}

/** The raw prefs object for a read-modify-write. A corrupt file is copied to prefs.json.corrupt before it is replaced. */
function loadRaw(): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file(), 'utf8');
  } catch {
    return {};
  }
  try {
    const data: unknown = JSON.parse(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // fall through to the backup
  }
  try {
    fs.copyFileSync(file(), `${file()}.corrupt`);
  } catch {
    // best effort
  }
  return {};
}

export function setModePref(dir: string, mode: Mode): void {
  // merge into the raw object: unknown top-level keys and other projects' entries survive the save
  const raw = loadRaw();
  const modes = raw.modes && typeof raw.modes === 'object' && !Array.isArray(raw.modes) ? (raw.modes as Record<string, unknown>) : {};
  modes[prefsKey(dir)] = mode;
  raw.modes = modes;
  const f = file();
  const tmp = `${f}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, f);
}

/** the project's model choice; atomic like setModePref */
export function setModelPref(dir: string, choice: ModelChoice): void {
  updateRawPrefs((raw) => {
    const m = raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models) ? (raw.models as Record<string, unknown>) : {};
    m[prefsKey(dir)] = { model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}) };
    raw.models = m;
  });
}

export function setIdleCompactPref(dir: string, on: boolean): void {
  updateRawPrefs((raw) => {
    const m = raw.idleCompact && typeof raw.idleCompact === 'object' && !Array.isArray(raw.idleCompact) ? (raw.idleCompact as Record<string, unknown>) : {};
    m[prefsKey(dir)] = on;
    raw.idleCompact = m;
  });
}

/** Read-modify-write of the raw prefs object: unknown keys survive. Atomic like setModePref. */
export function updateRawPrefs(fn: (raw: Record<string, unknown>) => void): void {
  const raw = loadRaw();
  fn(raw);
  const f = file();
  const tmp = `${f}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, f);
}

/** Settings → Defaults: the mode a project without its own entry starts in. */
export function setDefaultModePref(mode: Mode): void {
  updateRawPrefs((raw) => void (raw.defaultMode = mode));
}

/** Settings → Defaults: one for every window of this provider, like the language. */
export function setUpdateCheckPref(on: boolean): void {
  updateRawPrefs((raw) => void (raw.updateCheck = on));
}

/** Dictation with Whisper on the host: on only after the install; one for every window of this provider. */
export function setWhisperPref(on: boolean): void {
  updateRawPrefs((raw) => void (raw.whisper = on));
}

/** Settings → Defaults: the audit log, one for every window of this provider. */
export function setAuditPref(on: boolean): void {
  updateRawPrefs((raw) => void (raw.audit = on));
}

/** The UI language, one for every window of this user (not per project, not per port). */
export function setLangPref(lang: UiLang, ifUnset = false): void {
  // ifUnset (the migration of an old localStorage choice): decided inside the read-modify-write, so it can never overwrite
  // a choice another window made a moment earlier
  updateRawPrefs((raw) => void (ifUnset && isUiLang(raw.lang) ? undefined : (raw.lang = lang)));
}

/** The interface scale, one for every window of this user, like the language. */
export function setUiScalePref(scale: UiScale): void {
  updateRawPrefs((raw) => void (raw.uiScale = scale));
}

export function setThemePref(theme: ThemeId): void {
  updateRawPrefs((raw) => void (raw.theme = theme));
}
