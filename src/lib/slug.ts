const NON_ALPHANUMERIC_SEQUENCE = /[^a-z0-9]+/g;
const LEADING_OR_TRAILING_HYPHENS = /^-+|-+$/g;

/**
 * Converts text into Blogspage's canonical programmatic blog-post slug.
 *
 * This exactly mirrors the `seed-meta.ts` algorithm documented in
 * `knowledge/slug-system.md`: lowercase, remove ampersands, collapse each
 * non-alphanumeric run to one hyphen, then trim boundary hyphens.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, '')
    .replace(NON_ALPHANUMERIC_SEQUENCE, '-')
    .replace(LEADING_OR_TRAILING_HYPHENS, '');
}

/**
 * Chooses the first available slug by appending `-2`, `-3`, and so on to a
 * colliding base slug. It does not perform any external uniqueness check.
 *
 * @throws {RangeError} When `baseSlug` is empty or `maxAttempts` is invalid.
 */
export function resolveSlugCollision(
  baseSlug: string,
  existingSlugs: ReadonlySet<string>,
  maxAttempts = 100,
): string {
  if (baseSlug.length === 0) {
    throw new RangeError('baseSlug must be non-empty.');
  }

  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive safe integer.');
  }

  if (!existingSlugs.has(baseSlug)) {
    return baseSlug;
  }

  for (let suffix = 2; suffix <= maxAttempts + 1; suffix += 1) {
    const candidate = `${baseSlug}-${String(suffix)}`;
    if (!existingSlugs.has(candidate)) {
      return candidate;
    }
  }

  throw new RangeError(
    `Could not resolve a unique slug for "${baseSlug}" within ${String(maxAttempts)} suffix attempts.`,
  );
}
