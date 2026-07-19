/** Blogspage's documented editorial reading-speed baseline. */
export const WORDS_PER_MINUTE = 225;

/**
 * Estimates whole reading minutes from a word count, mirroring Blogspage
 * Agency's `Math.max(1, round(words / 225))` behavior.
 *
 * @throws {RangeError} When `wordCount` is negative or not a safe integer.
 */
export function estimateReadingTimeMinutes(wordCount: number): number {
  if (!Number.isSafeInteger(wordCount) || wordCount < 0) {
    throw new RangeError('wordCount must be a non-negative safe integer.');
  }

  return Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
}

/** Formats a reading-time duration as the ISO 8601 `PT<n>M` representation. */
export function toIsoDuration(minutes: number): string {
  if (!Number.isSafeInteger(minutes) || minutes < 1) {
    throw new RangeError('minutes must be a positive safe integer.');
  }

  return `PT${String(minutes)}M`;
}
