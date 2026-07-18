import { describe, expect, it } from 'vitest';

import { Logger, type LogWriter } from '@/logging/logger.js';

class MemoryLogWriter implements LogWriter {
  public readonly lines: string[] = [];

  public append(line: string): Promise<void> {
    this.lines.push(line);
    return Promise.resolve();
  }
}

class FailingLogWriter implements LogWriter {
  public append(): Promise<void> {
    return Promise.reject(new Error('disk unavailable'));
  }
}

describe('Logger', () => {
  it('writes structured JSONL error records with required triage metadata', async () => {
    const writer = new MemoryLogWriter();
    const logger = new Logger(writer, () => new Date('2026-07-18T06:00:00.000Z'));

    await logger.error({
      attemptNumber: 2,
      context: { input: 'article brief' },
      errorClass: 'ProviderError',
      message: 'Provider request timed out',
      module: 'research',
      providerName: 'anthropic',
      runId: 'run-123',
    });

    expect(writer.lines).toHaveLength(1);
    expect(JSON.parse(writer.lines[0] ?? '')).toEqual({
      attemptNumber: 2,
      context: { input: 'article brief' },
      errorClass: 'ProviderError',
      level: 'error',
      message: 'Provider request timed out',
      module: 'research',
      providerName: 'anthropic',
      runId: 'run-123',
      timestamp: '2026-07-18T06:00:00.000Z',
    });
  });

  it('redacts sensitive fields, bearer credentials, query secrets, and known secret values', async () => {
    const writer = new MemoryLogWriter();
    const logger = new Logger(writer, undefined, ['known-api-key']);

    await logger.log({
      attemptNumber: 1,
      context: {
        apiKey: 'api-key-in-context',
        nested: {
          authorization: 'Bearer should-not-appear',
          safeValue: 'known-api-key',
        },
      },
      level: 'warn',
      message:
        'Request failed with Bearer bearer-token and https://example.test?token=query-token; known-api-key',
      module: 'publish',
      runId: 'run-456',
    });

    const serialized = writer.lines[0] ?? '';

    expect(serialized).not.toContain('api-key-in-context');
    expect(serialized).not.toContain('should-not-appear');
    expect(serialized).not.toContain('bearer-token');
    expect(serialized).not.toContain('query-token');
    expect(serialized).not.toContain('known-api-key');
    expect(JSON.parse(serialized)).toMatchObject({
      context: {
        apiKey: '[REDACTED]',
        nested: { authorization: '[REDACTED]', safeValue: '[REDACTED]' },
      },
    });
  });

  it('swallows writer failures so logging cannot interrupt pipeline control flow', async () => {
    const logger = new Logger(new FailingLogWriter());

    await expect(
      logger.log({
        attemptNumber: 1,
        level: 'info',
        message: 'This log write will fail.',
        module: 'research',
        runId: 'run-789',
      }),
    ).resolves.toBeUndefined();
  });
});
