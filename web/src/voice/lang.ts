import { getLang } from '@/i18n/index.ts';
import type { RootState } from '@/store/store.ts';

/** The UI language as Whisper takes it: an ISO 639 code (zh-CN → zh, pt-BR → pt). */
export const whisperLang = (): string => getLang().split('-')[0]!;

/** `1:05`, from milliseconds; a recording is shown rounded up, so a 0.4 s one reads 0:01 and never 0:00. */
export function clock(ms: number, up = false): string {
  const s = Math.max(0, up ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Protocol 18: the server can detect the spoken language (`detect`), and the host stores the user's choice. */
export const DETECT_PROTOCOL = 18;

/**
 * What a dictation request says about the language: Auto (the default, `dictationLang` absent or `auto`) asks the server to
 * detect it, the UI language being the hint; a pinned code is sent as `lang` alone. A server older than protocol 18 only
 * knows `lang`, so it gets the UI language as before.
 */
export const dictationAsk = (s: RootState): { lang: string; detect?: true } => {
  const pref = s.controls.dictationLang;
  if (s.controls.protocol < DETECT_PROTOCOL) return { lang: whisperLang() };
  return !pref || pref === 'auto' ? { lang: whisperLang(), detect: true } : { lang: pref };
};

/** "French" for `fr`, in the interface language; the code itself when the browser does not know it. */
export function langName(code: string): string {
  try { return new Intl.DisplayNames(getLang(), { type: 'language' }).of(code) ?? code; } catch { return code; }
}
