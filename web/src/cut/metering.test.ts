import { expect, it } from 'vitest';
import { ampDb, FALL, meterFrac, meterStep, METER_FLOOR, PEAK_HOLD, peakOf, quiet } from './metering.ts';

it('a sample peak in dBFS: full scale is 0, half is about −6, silence is the floor', () => {
  expect(ampDb(1)).toBe(0);
  expect(ampDb(0.5)).toBeCloseTo(-6.02, 2);
  expect(ampDb(2)).toBeCloseTo(6.02, 2);
  expect(ampDb(0)).toBe(METER_FLOOR);
  expect(ampDb(1e-9)).toBe(METER_FLOOR);
});

it('the loudest sample of a block, either sign', () => {
  expect(peakOf(new Float32Array([0.1, -0.7, 0.3]))).toBeCloseTo(0.7);
  expect(peakOf(new Float32Array(4))).toBe(0);
});

it('a bar fills from the floor to 0 dBFS, past 0 stays full', () => {
  expect(meterFrac(METER_FLOOR)).toBe(0);
  expect(meterFrac(METER_FLOOR / 2)).toBe(0.5);
  expect(meterFrac(0)).toBe(1);
  expect(meterFrac(3)).toBe(1);
  expect(meterFrac(-200)).toBe(0);
});

it('the bar rises at once and falls at FALL dB a second', () => {
  let c = meterStep(quiet(), 0.5, 0, 0);
  expect(c.level).toBeCloseTo(-6.02, 2);
  c = meterStep(c, 0, 500, 500);
  expect(c.level).toBeCloseTo(-6.02 - FALL / 2, 2);
  c = meterStep(c, 0, 10_000, 10_500);
  expect(c.level).toBe(METER_FLOOR);
});

it('the peak holds for PEAK_HOLD, then falls, never under the bar', () => {
  let c = meterStep(quiet(), 1, 0, 0);
  expect(c.peak).toBe(0);
  c = meterStep(c, 0.1, PEAK_HOLD - 100, PEAK_HOLD - 100);
  expect(c.peak).toBe(0);
  c = meterStep(c, 0.1, 500, PEAK_HOLD + 400);
  // it falls only for the time past its hold
  expect(c.peak).toBeCloseTo(-FALL * 0.4, 5);
  // a louder one takes the hold again from its time
  c = meterStep(c, 0.9, 16, PEAK_HOLD + 416);
  expect(c.peak).toBeCloseTo(ampDb(0.9), 5);
  expect(c.peakAt).toBe(PEAK_HOLD + 416);
  // a long fall stops at the bar
  c = meterStep(c, 0.25, 20_000, 30_000);
  expect(c.peak).toBeCloseTo(c.level, 5);
});

it('a sample at or over full scale latches the clip until reset', () => {
  let c = meterStep(quiet(), 0.99, 0, 0);
  expect(c.clip).toBe(false);
  c = meterStep(c, 1, 16, 16);
  expect(c.clip).toBe(true);
  c = meterStep(c, 0, 5000, 5016);
  expect(c.clip).toBe(true);
  expect({ ...c, clip: false }.clip).toBe(false);
});
