import { getLang, t as tNow } from '@/i18n/index.ts';

// Every number the UI shows, in the UI language (issue 469): one Intl formatter per language and kind, made once.
const made = new Map<string, Intl.NumberFormat>();
const nf = (kind: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat => {
  const key = `${getLang()} ${kind}`;
  let f = made.get(key);
  if (!f) made.set(key, (f = new Intl.NumberFormat(getLang(), opts)));
  return f;
};
// as the phone writes it (mobile/app/lib/usage/format.dart): three significant digits in a short unit, and every digit of
// a count too small for one (German has no unit for thousands: 45.678)
const COMPACT: Intl.NumberFormatOptions = { notation: 'compact', maximumSignificantDigits: 3, maximumFractionDigits: 0, roundingPriority: 'morePrecision' };

/** A count with the language's grouping: 1,234,567. */
export const num = (n: number): string => nf('num', {}).format(n);
/** A large count the short way, in the language's own units: 1.5K, 2,5 млн, 250万. */
export const compact = (n: number): string => nf('compact', COMPACT).format(n);
/** The same, as parts: the trip meter puts the digits on wheels. */
export const compactParts = (n: number): Intl.NumberFormatPart[] => nf('compact', COMPACT).formatToParts(n);
/** A fraction as a whole percent: 0.33 -> 33%, 33 %. */
export const percent = (v: number): string => nf('percent', { style: 'percent' }).format(v);
/** Minor units to the currency's own format; the currency says how many digits a minor unit is. */
export function money(minor: number, currency: string | null): string {
  const f = nf(`money ${currency ?? 'USD'}`, { style: 'currency', currency: currency ?? 'USD' });
  return f.format(minor / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2));
}
const BYTES = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
/** A size in the unit that reads best: 3 B, 1.5 MB, 2 ГБ (999 999 bytes are 1 MB, not 1000 kB). */
export function byteSize(n: number): string {
  let i = 0;
  while (i < BYTES.length - 1 && n / 1000 ** i >= 999.95) i++;
  if (i === 0 && getLang() === 'en') return `${num(n)} B`; // CLDR's English "3 byte" reads oddly
  return nf(`bytes ${i}`, { style: 'unit', unit: BYTES[i], maximumFractionDigits: 1 }).format(n / 1000 ** i);
}

/** Prototype `ago`: just now, N min ago, N h ago, then a short date. */
export const ago = (at: number, now = Date.now()): string => {
  const m = Math.round((now - at) / 60000);
  return m < 1 ? tNow('justNow') : m < 60 ? tNow('minAgo', m) : m < 1440 ? tNow('hAgo', Math.round(m / 60))
    : new Date(at).toLocaleDateString(getLang(), { day: 'numeric', month: 'short' });
};
