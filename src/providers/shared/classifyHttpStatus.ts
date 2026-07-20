/**
 * Generic HTTP-status-to-retryability classification shared by every adapter
 * that talks to an HTTP-based provider API (Anthropic, OpenAI, Gemini,
 * OpenRouter — all four map their SDK/HTTP errors through this same rule).
 * This is deliberately provider-agnostic: it knows nothing about any one
 * provider's error shape, only about HTTP status-code semantics, so placing
 * it in providers/shared/ does not violate "no provider-specific logic
 * leaks outside its adapter" (07-error-handling.md, 08-retry-strategy.md).
 */

/**
 * Returns whether a provider-transient retry (08-retry-strategy.md) is
 * appropriate for the given HTTP status. `undefined` covers network errors
 * and timeouts, which have no status code but are equally transient.
 */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) {
    return true;
  }

  if (status === 429) {
    return true;
  }

  return status >= 500 && status < 600;
}
