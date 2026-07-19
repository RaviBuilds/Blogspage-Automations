import { createHash } from 'node:crypto';
import { extname } from 'node:path';

import { slugify } from '@/lib/slug.js';

const DEFAULT_BASENAME = 'file';
const DEFAULT_HASH_LENGTH = 8;
const MAX_HASH_LENGTH = 64;
const SAFE_EXTENSION_PATTERN = /^\.[a-z0-9]+$/;

/** Returns a lowercased, safe extension (including its leading dot), or an empty string. */
export function normalizeExtension(extension: string): string {
  if (extension.length === 0) {
    return '';
  }

  const normalized = extension.startsWith('.')
    ? extension.toLowerCase()
    : `.${extension.toLowerCase()}`;

  if (!SAFE_EXTENSION_PATTERN.test(normalized)) {
    throw new RangeError(`Extension "${extension}" must contain only ASCII letters and digits.`);
  }

  return normalized;
}

/**
 * Creates a deterministic, collision-resistant local asset filename.
 * The short SHA-256 suffix prevents distinct original labels that normalize to
 * the same slug from overwriting each other.
 *
 * @throws {RangeError} When `label` is blank or `hashLength` is outside 1-64.
 */
export function createSafeFilename(
  label: string,
  options: { readonly extension?: string; readonly hashLength?: number } = {},
): string {
  if (label.trim().length === 0) {
    throw new RangeError('label must contain at least one non-whitespace character.');
  }

  const hashLength = options.hashLength ?? DEFAULT_HASH_LENGTH;
  if (!Number.isSafeInteger(hashLength) || hashLength < 1 || hashLength > MAX_HASH_LENGTH) {
    throw new RangeError(
      `hashLength must be a safe integer between 1 and ${String(MAX_HASH_LENGTH)}.`,
    );
  }

  const derivedExtension = options.extension ?? extname(label);
  const extension = normalizeExtension(derivedExtension);
  const basenameSource =
    extension.length > 0 && label.toLowerCase().endsWith(extension)
      ? label.slice(0, -extension.length)
      : label;
  const basename = slugify(basenameSource) || DEFAULT_BASENAME;
  const shortHash = createHash('sha256').update(label, 'utf8').digest('hex').slice(0, hashLength);

  return `${basename}-${shortHash}${extension}`;
}
