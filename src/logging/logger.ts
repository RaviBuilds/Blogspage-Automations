import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { PipelineErrorClass } from '@/core/types.js';

const REDACTED_VALUE = '[REDACTED]';
const SENSITIVE_FIELD_PATTERN = /api[_-]?key|authorization|credential|password|secret|token/i;
const BEARER_TOKEN_PATTERN = /(bearer\s+)[^\s,]+/gi;
const QUERY_SECRET_PATTERN = /((?:api[_-]?key|token|secret|password)=)[^&\s,]+/gi;

/** Structured severity used by the pipeline's JSON-lines logs. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A structured event emitted for normal pipeline activity. */
export interface LogEntry {
  readonly attemptNumber: number;
  readonly context?: unknown;
  readonly level: LogLevel;
  readonly message: string;
  readonly module: string;
  readonly providerName?: string;
  readonly runId: string;
  readonly timestamp?: string;
}

/** A structured event emitted for a classified pipeline failure. */
export interface ErrorLogEntry extends Omit<LogEntry, 'level'> {
  readonly errorClass: PipelineErrorClass;
}

/** Destination abstraction used to keep the logger independently testable. */
export interface LogWriter {
  append(line: string): Promise<void>;
}

/** Appends structured log records to one UTC-date JSONL file under logs/. */
export class FileLogWriter implements LogWriter {
  public constructor(private readonly logDirectory: string) {}

  public async append(line: string): Promise<void> {
    await mkdir(this.logDirectory, { recursive: true });
    const filename = `${new Date().toISOString().slice(0, 10)}.jsonl`;
    await appendFile(resolve(this.logDirectory, filename), line, 'utf8');
  }
}

/**
 * Non-throwing structured logger for all pipeline infrastructure and modules.
 * Logging failures are intentionally swallowed so observability never changes
 * pipeline control flow.
 */
export class Logger {
  public constructor(
    private readonly writer: LogWriter,
    private readonly now: () => Date = () => new Date(),
    private readonly sensitiveValues: readonly string[] = [],
  ) {}

  /** Records a non-error structured event. */
  public async log(entry: LogEntry): Promise<void> {
    await this.write(entry);
  }

  /** Records a classified pipeline error with the fields required for triage. */
  public async error(entry: ErrorLogEntry): Promise<void> {
    await this.write({ ...entry, level: 'error' });
  }

  private async write(
    entry: LogEntry | (ErrorLogEntry & { readonly level: 'error' }),
  ): Promise<void> {
    try {
      const serialized = JSON.stringify(sanitizeLogEntry(entry, this.now, this.sensitiveValues));
      await this.writer.append(`${serialized}\n`);
    } catch {
      // Logging must never interrupt a pipeline run.
    }
  }
}

/**
 * Creates the default file-backed logger. Supply a LogWriter only for tests or
 * alternate runtime destinations; pipeline modules depend on Logger itself.
 */
export function createLogger(
  options: {
    readonly logDirectory?: string;
    readonly now?: () => Date;
    readonly sensitiveValues?: readonly string[];
    readonly writer?: LogWriter;
  } = {},
): Logger {
  const writer =
    options.writer ?? new FileLogWriter(options.logDirectory ?? resolve(process.cwd(), 'logs'));

  return new Logger(writer, options.now, options.sensitiveValues);
}

function sanitizeLogEntry(
  entry: LogEntry | (ErrorLogEntry & { readonly level: 'error' }),
  now: () => Date,
  sensitiveValues: readonly string[],
): Record<string, unknown> {
  const sanitized = sanitizeValue(entry, sensitiveValues);

  return {
    ...(isRecord(sanitized) ? sanitized : {}),
    timestamp: entry.timestamp ?? now().toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeValue(
  value: unknown,
  sensitiveValues: readonly string[],
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') {
    return redactText(value, sensitiveValues);
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'undefined') {
    return undefined;
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return String(value);
  }

  if (value instanceof Error) {
    return sanitizeValue(
      { name: value.name, message: value.message, stack: value.stack },
      sensitiveValues,
      seen,
    );
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, sensitiveValues, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);
    const sanitized: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      sanitized[key] = SENSITIVE_FIELD_PATTERN.test(key)
        ? REDACTED_VALUE
        : sanitizeValue(nestedValue, sensitiveValues, seen);
    }

    return sanitized;
  }

  return JSON.stringify(value) ?? '[Unserializable]';
}

function redactText(value: string, sensitiveValues: readonly string[]): string {
  let redacted = value
    .replace(BEARER_TOKEN_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(QUERY_SECRET_PATTERN, `$1${REDACTED_VALUE}`);

  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length > 0) {
      redacted = redacted.replaceAll(sensitiveValue, REDACTED_VALUE);
    }
  }

  return redacted;
}
