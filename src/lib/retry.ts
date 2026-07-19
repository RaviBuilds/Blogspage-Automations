/** Inputs for pure exponential-backoff delay calculation. */
export interface BackoffOptions {
  readonly attempt: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
  /** A deterministic random value in [0, 1], injectable for reproducible tests. */
  readonly random?: () => number;
}

/**
 * Computes one exponential-backoff delay with optional symmetric jitter.
 * Attempt numbers are zero-based: attempt 0 waits `baseDelayMs`, attempt 1
 * waits twice that delay, and so on, capped at `maxDelayMs` before jitter.
 *
 * @throws {RangeError} When any numeric input is out of range.
 */
export function computeDelay(options: BackoffOptions): number {
  const { attempt, baseDelayMs, maxDelayMs, jitterRatio, random = Math.random } = options;

  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new RangeError('attempt must be a non-negative safe integer.');
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) {
    throw new RangeError('baseDelayMs must be a positive finite number.');
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new RangeError('maxDelayMs must be finite and at least baseDelayMs.');
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new RangeError('jitterRatio must be a finite number between 0 and 1.');
  }

  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    throw new RangeError('random must return a finite number between 0 and 1.');
  }

  const cappedDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  const jitterMultiplier = 1 + (randomValue * 2 - 1) * jitterRatio;

  return Math.round(cappedDelay * jitterMultiplier);
}
