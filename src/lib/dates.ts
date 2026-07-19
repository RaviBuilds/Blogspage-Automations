const ISO_8601_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Formats a valid Date as a canonical UTC ISO 8601 timestamp. */
export function toIsoTimestamp(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('date must be a valid Date.');
  }

  return date.toISOString();
}

/**
 * Parses and validates a canonical UTC ISO 8601 timestamp.
 *
 * @throws {RangeError} When the timestamp is malformed, non-canonical, or an
 * impossible calendar date.
 */
export function parseIsoTimestamp(value: string): Date {
  if (!ISO_8601_UTC_PATTERN.test(value)) {
    throw new RangeError('value must be a canonical UTC ISO 8601 timestamp.');
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new RangeError(`value is not a real canonical UTC timestamp: "${value}".`);
  }

  return date;
}

/** Returns true only for a real canonical UTC ISO 8601 timestamp. */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    parseIsoTimestamp(value);
    return true;
  } catch {
    return false;
  }
}
