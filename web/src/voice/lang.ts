import { getLang } from '@/i18n/index.ts';

/** The UI language as Whisper takes it: an ISO 639 code (zh-CN → zh, pt-BR → pt). */
export const whisperLang = (): string => getLang().split('-')[0]!;

/** `1:05`, from milliseconds; a recording is shown rounded up, so a 0.4 s one reads 0:01 and never 0:00. */
export function clock(ms: number, up = false): string {
  const s = Math.max(0, up ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
