import { getLang } from '@/sdk';

/** `1:05`, from milliseconds; a recording is shown rounded up, so a 0.4 s one reads 0:01 and never 0:00. */
export function clock(ms: number, up = false): string {
  const s = Math.max(0, up ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}


/** "French" for `fr`, in the interface language; the code itself when the browser does not know it. */
export function langName(code: string): string {
  try { return new Intl.DisplayNames(getLang(), { type: 'language' }).of(code) ?? code; } catch { return code; }
}
