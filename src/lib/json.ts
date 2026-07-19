import type { ZodType } from 'zod';

import { ValidationError } from '@/core/errors.js';
import { assertValid } from '@/lib/schemaValidator.js';

/** Extracts the first complete JSON object or array from model output. */
export function extractJsonValue(text: string, module: string): string {
  const source = text.trim();
  const start = source.search(/[[{]/);

  if (start === -1) {
    throw new ValidationError(module, ['Response did not contain a JSON object or array.']);
  }

  const opening = source[start] ?? '';
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index] ?? '';

    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new ValidationError(module, ['Response contained an incomplete JSON value.']);
}

/**
 * Parses model output as strict JSON, tolerating surrounding prose or a single
 * Markdown code fence, then validates it against `schema`.
 *
 * @throws {ValidationError} When JSON is malformed or fails schema validation.
 */
export function parseJsonWithSchema<T>(text: string, schema: ZodType<T>, module: string): T {
  const jsonText = extractJsonValue(text, module);

  try {
    return assertValid(schema, JSON.parse(jsonText) as unknown, module);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }

    throw new ValidationError(module, [
      `Response contained invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}
