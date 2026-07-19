import { ValidationError } from '@/core/errors.js';
import type { ZodType } from 'zod';

/** Formats Zod issues consistently for every future module validator. */
export function formatSchemaIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
}

/**
 * Validates unknown data with a Zod schema and returns the parsed result.
 *
 * @throws {ValidationError} When the data does not conform to `schema`.
 */
export function assertValid<T>(schema: ZodType<T>, data: unknown, module: string): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    throw new ValidationError(module, formatSchemaIssues(result.error.issues));
  }

  return result.data;
}
