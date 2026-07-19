/**
 * Estimates token count with the documented provider-independent heuristic of
 * four UTF-16 code units per token. This is for budgeting only; a provider's
 * reported usage is always authoritative after a real call.
 */
export function estimateTokenCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.ceil(text.length / 4);
}

/** Estimates the aggregate token count of independent text segments. */
export function estimateTokenCountForParts(parts: readonly string[]): number {
  return parts.reduce((total, part) => total + estimateTokenCount(part), 0);
}
