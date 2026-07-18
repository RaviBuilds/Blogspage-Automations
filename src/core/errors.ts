import type { PipelineErrorClass } from '@/core/types.js';

/** Base implementation for the pipeline's typed, classifiable errors. */
abstract class PipelineError extends Error {
  public abstract override readonly name: PipelineErrorClass;

  protected constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when a module's input or output fails its declared validation rules. */
export class ValidationError extends PipelineError {
  public override readonly name = 'ValidationError' as const;

  public constructor(
    public readonly module: string,
    public readonly details: readonly string[],
  ) {
    super(`Validation failed in ${module}: ${details.join('; ')}`);
  }
}

/** Raised when an external provider reports a failure. */
export class ProviderError extends PipelineError {
  public override readonly name = 'ProviderError' as const;

  public constructor(
    public readonly module: string,
    public readonly providerName: string,
    public readonly statusCode: number | undefined,
    public readonly retryable: boolean,
  ) {
    super(
      `Provider ${providerName} failed in ${module}${
        statusCode === undefined ? '' : ` (status ${statusCode})`
      }.`,
    );
  }
}

/** Raised for a known-safe transient failure that is not provider-specific. */
export class RetryableError extends PipelineError {
  public override readonly name = 'RetryableError' as const;

  public constructor(public readonly module: string) {
    super(`Retryable failure in ${module}.`);
  }
}

/** Raised for an unrecoverable failure that must not be retried automatically. */
export class FatalError extends PipelineError {
  public override readonly name = 'FatalError' as const;

  public constructor(
    public readonly module: string,
    public readonly reason: string,
  ) {
    super(`Fatal failure in ${module}: ${reason}`);
  }
}
