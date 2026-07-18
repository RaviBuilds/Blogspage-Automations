import { describe, expect, it } from 'vitest';

import { FatalError, ProviderError, RetryableError, ValidationError } from '@/core/errors.js';

describe('pipeline error taxonomy', () => {
  it('preserves validation context and Error inheritance', () => {
    const error = new ValidationError('writer', ['title is required', 'excerpt is too short']);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ValidationError');
    expect(error.module).toBe('writer');
    expect(error.details).toEqual(['title is required', 'excerpt is too short']);
    expect(error.message).toContain('title is required; excerpt is too short');
  });

  it('preserves provider retry classification metadata', () => {
    const error = new ProviderError('research', 'anthropic', 429, true);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProviderError');
    expect(error.module).toBe('research');
    expect(error.providerName).toBe('anthropic');
    expect(error.statusCode).toBe(429);
    expect(error.retryable).toBe(true);
  });

  it('distinguishes retryable and fatal failures', () => {
    const retryable = new RetryableError('state-store');
    const fatal = new FatalError('config', 'SANITY_DATASET is missing');

    expect(retryable.name).toBe('RetryableError');
    expect(retryable.module).toBe('state-store');
    expect(fatal.name).toBe('FatalError');
    expect(fatal.module).toBe('config');
    expect(fatal.reason).toBe('SANITY_DATASET is missing');
  });
});
