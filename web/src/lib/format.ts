import { getLang } from '@/i18n/index.ts';

// Every number the UI shows, in the UI language (issue 469): one Intl formatter per language and kind, made once.
const made = new Map<string, Intl.NumberFormat>();
const nf = (kind: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat => {
  const key = `${getLang()} ${kind}`;
  let f = made.get(key);
  if (!f) made.set(key, (f = new Intl.NumberFormat(getLang(), opts)));
  return f;
};
// as the phone's intl compact writes it (mobile/app/lib/usage/format.dart): three significant digits in a short unit, and
// every digit, ungrouped, of a count too small for one (German has no unit for thousands)
const COMPACT: Intl.NumberFormatOptions = { notation: 'compact', maximumSignificantDigits: 3, maximumFractionDigits: 0, roundingPriority: 'morePrecision', useGrouping: false };

/** A count with the language's grouping: 1,234,567. */
export const num = (n: number): string => nf('num', {}).format(n);
/** A large count the short way, in the language's own units: 1.5K, 2,5 млн, 250万. */
export const compact = (n: number): string => nf('compact', COMPACT).format(n);
/** The same, as parts: the trip meter puts the digits on wheels. */
export const compactParts = (n: number): Intl.NumberFormatPart[] => nf('compact', COMPACT).formatToParts(n);
/** Minor units to the currency's own format; the currency says how many digits a minor unit is. */
export function money(minor: number, currency: string | null): string {
  const f = nf(`money ${currency ?? 'USD'}`, { style: 'currency', currency: currency ?? 'USD' });
  return f.format(minor / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2));
}
const BYTES = ['kilobyte', 'megabyte', 'gigabyte'] as const;
/** A size in the unit that reads best, a kilobyte the least: 0.5 kB, 1.5 MB, 2 ГБ. */
export function byteSize(n: number): string {
  const i = Math.max(0, Math.min(BYTES.length - 1, Math.floor(Math.log10(Math.max(n, 1)) / 3) - 1));
  return nf(`bytes ${i}`, { style: 'unit', unit: BYTES[i], maximumFractionDigits: 1 }).format(n / 1000 ** (i + 1));
}
