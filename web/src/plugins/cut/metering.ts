// The preview's master level meter (issue 410) as pure sums: a block's sample peak in dBFS, a bar that rises at once
// and falls at FALL dB a second, a peak that holds for PEAK_HOLD and then falls, and a clip latch at full scale. The
// engine reads the blocks (engine.ts meterPeaks), Meter.tsx draws them.

/** The bar's bottom, dBFS: anything quieter shows as nothing. */
export const METER_FLOOR = -60;
/** How long a peak mark stays where it was, ms. */
export const PEAK_HOLD = 1500;
/** How fast the bar and a peak mark past its hold fall, dB a second. */
export const FALL = 24;

export type MeterChannel = {
  /** the bar, dBFS */
  level: number;
  /** the peak mark, dBFS, and when it was set (ms) */
  peak: number;
  peakAt: number;
  /** a sample reached full scale since the last reset */
  clip: boolean;
};

export const quiet = (): MeterChannel => ({ level: METER_FLOOR, peak: METER_FLOOR, peakAt: 0, clip: false });

/** An amplitude (1 is full scale) in dBFS, not under the floor. */
export const ampDb = (a: number): number => (a > 0 ? Math.max(METER_FLOOR, 20 * Math.log10(a)) : METER_FLOOR);

/** The loudest sample of a block, either sign. */
export function peakOf(buf: Float32Array): number {
  let m = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]!);
    if (v > m) m = v;
  }
  return m;
}

/** How much of the bar a level fills: 0 at the floor, 1 at 0 dBFS and over. */
export const meterFrac = (db: number): number => Math.min(1, Math.max(0, (db - METER_FLOOR) / -METER_FLOOR));

/** The channel after a block whose peak is `amp`, `dt` ms after the last one, at `now` ms. */
export function meterStep(c: MeterChannel, amp: number, dt: number, now: number): MeterChannel {
  const db = ampDb(amp);
  const level = Math.max(db, c.level - (FALL * dt) / 1000, METER_FLOOR);
  let { peak, peakAt } = c;
  if (db >= peak) {
    peak = db;
    peakAt = now;
  } else {
    const past = Math.min(dt, now - peakAt - PEAK_HOLD);
    if (past > 0) peak = Math.max(level, peak - (FALL * past) / 1000);
  }
  return { level, peak, peakAt, clip: c.clip || amp >= 1 };
}
