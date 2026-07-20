import { describe, expect, it } from 'vitest';

import { isRetryableStatus } from '@/providers/shared/classifyHttpStatus.js';

describe('isRetryableStatus', () => {
  it('treats network errors/timeouts (no status) as retryable', () => {
    expect(isRetryableStatus(undefined)).toBe(true);
  });

  it('treats 429 as retryable', () => {
    expect(isRetryableStatus(429)).toBe(true);
  });

  it('treats every 5xx as retryable', () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });

  it('treats 400/401/403/404 as non-retryable', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it('treats 600+ and 2xx/3xx as non-retryable boundary cases', () => {
    expect(isRetryableStatus(600)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(499)).toBe(false);
  });
});
