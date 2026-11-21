import { isUiLang, type UiLang } from '@nota-bene/shared';
import { storage, useStored } from '../sdk/storage.ts';
import { de } from './de.ts';
import { en } from './en.ts';
import { es } from './es.ts';
import { ptBR } from './pt-BR.ts';
import { ru } from './ru.ts';
import { zhCN } from './zh-CN.ts';

export type Lang = UiLang;
/** A translation key: the Russian dictionary is the reference. */
export type I18nKey = keyof typeof ru;

const DICTS: Record<Lang, Record<string, unknown>> = { en, ru, 'zh-CN': zhCN, es, 'pt-BR': ptBR, de };

/** The languages on offer, each named in itself; adding one here adds it to the header menu and to Settings. */
export const LANGS: { id: Lang; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'ru', name: 'Русский' },
  { id: 'zh-CN', name: '简体中文' },
  { id: 'es', name: 'Español' },
  { id: 'pt-BR', name: 'Português (Brasil)' },
  { id: 'de', name: 'Deutsch' },
];

/** A stored choice wins; otherwise English, whatever the browser language says. */
export function initialLang(stored: string | null): Lang {
  return isUiLang(stored) ? stored : 'en';
}

// the choice: one for every window (prefs.json, hello.lang), cached in this origin's storage (sdk/storage.ts)
const lang = storage.pref('lang');
const applyLang = () => { if (typeof document !== 'undefined') document.documentElement.lang = lang.get(); };
applyLang();
lang.subscribe(applyLang);

export function getLang(): Lang {
  return lang.get();
}

/** This page's language, not sent (the server's value arriving, tests). */
export function setLang(l: Lang): void {
  lang.here(l);
}

/** The user picked a language (header menu, Settings): apply it here and save it for every window. */
export function chooseLang(l: Lang): void {
  void lang.set(l);
}

/**
 * The server's `hello.lang`: the server's value wins over this origin's cache, except while our own choice is unconfirmed
 * (then it is sent again and the hello, which may predate it, is ignored). With no value on the server yet, a choice this
 * browser already made is moved up if still unset there, so nobody loses it.
 */
export function adoptServerLang(server: string | undefined): void {
  lang.adopt(server);
}

/** test only: forget an unconfirmed choice */
export function resetUnsyncedLang(): void {
  lang.reload();
}

/** Translate into an explicit language (for text that must not follow the UI language, e.g. a sent batch). */
export function tIn(l: Lang, key: I18nKey, ...args: unknown[]): string {
  const k: string = key; // a plain string: the key union is too large for TypeScript to combine with unknown
  const v = DICTS[l][k] ?? DICTS.en[k] ?? k;
  return typeof v === 'function' ? String(v(...args)) : String(v);
}

export function t(key: I18nKey, ...args: unknown[]): string {
  return tIn(lang.get(), key, ...args);
}

/**
 * Re-renders the calling component when the language changes. The returned `t` is the same module-level
 * function every time, so it does NOT change identity: memoised children that call t() themselves need
 * their own useT() (or another prop that changes) to pick up a new language.
 */
export function useT(): typeof t {
  useStored(lang);
  return t;
}
