import { describe, expect, it } from 'vitest';

import { isIsoTimestamp, parseIsoTimestamp, toIsoTimestamp } from '@/lib/dates.js';
import { estimateReadingTimeMinutes, toIsoDuration, WORDS_PER_MINUTE } from '@/lib/readingTime.js';
import { computeDelay } from '@/lib/retry.js';
import { estimateTokenCount, estimateTokenCountForParts } from '@/lib/tokenCount.js';

describe('dates', () => {
  it('round-trips a valid UTC date through canonical ISO formatting', () => {
    const value = '2026-07-19T11:50:32.543Z';
    expect(toIsoTimestamp(parseIsoTimestamp(value))).toBe(value);
    expect(isIsoTimestamp(value)).toBe(true);
  });

  it('rejects non-canonical, impossible, and non-string timestamps', () => {
    expect(() => parseIsoTimestamp('2026-07-19')).toThrow(RangeError);
    expect(() => parseIsoTimestamp('2026-02-30T00:00:00.000Z')).toThrow(RangeError);
    expect(isIsoTimestamp('2026-07-19T11:50:32Z')).toBe(false);
    expect(isIsoTimestamp(null)).toBe(false);
    expect(() => toIsoTimestamp(new Date('invalid'))).toThrow(RangeError);
  });
});

describe('reading time', () => {
  it('mirrors the documented 225 WPM and minimum-one-minute behavior', () => {
    expect(WORDS_PER_MINUTE).toBe(225);
    expect(estimateReadingTimeMinutes(0)).toBe(1);
    expect(estimateReadingTimeMinutes(225)).toBe(1);
    expect(estimateReadingTimeMinutes(338)).toBe(2);
    expect(toIsoDuration(2)).toBe('PT2M');
  });

  it('rejects invalid counts and durations', () => {
    expect(() => estimateReadingTimeMinutes(-1)).toThrow(RangeError);
    expect(() => estimateReadingTimeMinutes(1.5)).toThrow(RangeError);
    expect(() => toIsoDuration(0)).toThrow(RangeError);
  });
});

describe('token estimates', () => {
  it('is stable and provider-independent', () => {
    expect(estimateTokenCount('')).toBe(0);
    expect(estimateTokenCount('1234')).toBe(1);
    expect(estimateTokenCount('12345')).toBe(2);
    expect(estimateTokenCount('東京')).toBe(1);
    expect(estimateTokenCountForParts(['1234', '12345'])).toBe(3);
  });
});

describe('computeDelay', () => {
  it('calculates exponential delays with deterministic symmetric jitter', () => {
    expect(
      computeDelay({
        attempt: 0,
        baseDelayMs: 500,
        maxDelayMs: 8_000,
        jitterRatio: 0,
        random: () => 0.5,
      }),
    ).toBe(500);
    expect(
      computeDelay({
        attempt: 3,
        baseDelayMs: 500,
        maxDelayMs: 8_000,
        jitterRatio: 0,
        random: () => 0.5,
      }),
    ).toBe(4_000);
    expect(
      computeDelay({
        attempt: 8,
        baseDelayMs: 500,
        maxDelayMs: 8_000,
        jitterRatio: 0,
        random: () => 0.5,
      }),
    ).toBe(8_000);
    expect(
      computeDelay({
        attempt: 0,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        jitterRatio: 0.2,
        random: () => 0,
      }),
    ).toBe(80);
    expect(
      computeDelay({
        attempt: 0,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        jitterRatio: 0.2,
        random: () => 1,
      }),
    ).toBe(120);
  });

  it('rejects malformed parameters and invalid injected random values', () => {
    const valid = { attempt: 0, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 };
    expect(() => computeDelay({ ...valid, attempt: -1 })).toThrow(RangeError);
    expect(() => computeDelay({ ...valid, baseDelayMs: 0 })).toThrow(RangeError);
    expect(() => computeDelay({ ...valid, maxDelayMs: 0 })).toThrow(RangeError);
    expect(() => computeDelay({ ...valid, jitterRatio: 2 })).toThrow(RangeError);
    expect(() => computeDelay({ ...valid, random: () => -0.1 })).toThrow(RangeError);
  });
});
