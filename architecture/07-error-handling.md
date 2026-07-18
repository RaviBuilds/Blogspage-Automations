# 07 — Error Handling

## Error taxonomy

Every error in the pipeline is one of exactly four typed classes, defined once in `src/core/errors.ts`. Module code never throws a bare `Error` — it throws (or the `moduleRunner` wrapper classifies a caught error into) one of these:

```ts
class ValidationError extends Error {
  // The module ran, but its own output (or its input) failed schema validation.
  // Not retryable by re-running the same call blindly — usually needs a
  // re-prompt with the validation failure appended (see 08-retry-strategy.md),
  // or, if input validation failed, is a bug in an upstream module.
  constructor(public module: string, public details: string[]) { ... }
}

class ProviderError extends Error {
  // The LLM/image/Sanity/Sheets provider call itself failed — network,
  // rate limit, 5xx, timeout, auth.
  constructor(public module: string, public providerName: string,
              public statusCode?: number, public retryable: boolean) { ... }
}

class RetryableError extends Error {
  // A generic wrapper for "this specific failure is known-safe to retry"
  // when it doesn't fit ProviderError's shape (e.g. a transient file-lock
  // on stateStore). Rare — most retryable conditions are ProviderErrors.
  constructor(public module: string) { ... }
}

class FatalError extends Error {
  // Not retryable under any policy. Missing required config, a hard
  // business-rule violation (e.g. excerpt genuinely cannot be brought into
  // the 50-200 char range after N attempts), or max review-loop iterations
  // exhausted. Always routes to human review or aborts the run — never
  // silently retried, never silently ignored.
  constructor(public module: string, public reason: string) { ... }
}
```

## Per-error-class handling

| Error class | `moduleRunner` behavior | Orchestrator behavior |
|---|---|---|
| `ValidationError` | Caught, logged with the specific validation failures; if the module supports re-prompting (most LLM modules do — see `08-retry-strategy.md`), retried with the error appended to the next prompt, up to that module's configured max attempts. | If retries exhaust: escalate to `FatalError` for that module, route the run to `needs_review`. |
| `ProviderError` (retryable: true) | Retried with exponential backoff per `08-retry-strategy.md`. | Not visible to the orchestrator unless retries exhaust. |
| `ProviderError` (retryable: true, exhausted) | Escalated to `FatalError`. | Route to `needs_review` (module-level failures on non-Publish steps) or `failed` (if it's Publish itself, after the idempotency check below). |
| `ProviderError` (retryable: false, e.g. 401/403) | Not retried — surfaced immediately as `FatalError`. | Run stops immediately; this is almost always a config problem (bad API key, revoked token), not a transient issue, and retrying would waste calls without fixing anything. |
| `RetryableError` | Same as `ProviderError` retryable path. | Same as above. |
| `FatalError` | Never retried. Logged with full context. | Run status set to `needs_review` or `failed` per the table above; Notification module always fires with the specific reason. |

## The idempotency problem at Publish

Publish (module 20) is the one place where a naive retry is actively dangerous: a timeout could mean "the write never reached Sanity" (safe to retry) or "the write succeeded but the response never came back" (retrying would create a duplicate post). The rule:

1. On any `ProviderError` from the Publish step, **before retrying**, re-query Sanity for a `post` document with the exact `slug.current` this run intended to write.
2. If found and its `_id` matches nothing this run has recorded yet, treat it as a successful prior write that just failed to acknowledge — record the result and proceed to Notification, **do not write again**.
3. If not found, the write genuinely never landed — safe to retry from scratch.

This check is cheap (one Sanity read) relative to the cost of a duplicate post existing in production, and it's the single most important error-handling rule in the whole pipeline because Publish is the only step with a real-world side effect that can't be trivially undone (per `automation-integration.md`, slugs must never change once live, so a duplicate can't just be silently renamed away later).

## Fail-closed, never fail-open

Two places in this pipeline are explicitly fail-closed by design, meaning "when in doubt, do not publish a degraded artifact":

1. **Review loop `failClosed`** (module 9, Technical QA gate): if `maxReviewIterations` is exhausted and issues remain, the orchestrator does **not** publish the best-available draft — it routes to `needs_review` with the full issue history attached, and a human decides whether to manually fix and resume, or discard the run.
2. **Structured-Data Readiness Validator** (module 18): a genuinely missing hard-required field (`excerpt`, `mainImage` if a hero image was planned) blocks the run rather than publishing with a gap that would produce broken structured data on the live site.

Everywhere else, a soft-missing field (e.g. `metaDescription` slightly outside the 120-160 char soft target) is logged as a warning and the run proceeds — the hard/soft distinction from `automation-integration.md` is preserved exactly in this pipeline's error-severity model, never flattened into "any imperfection blocks publishing."

## Image-loop partial failure

If an individual image (module 12/13) exhausts its retries, the orchestrator does **not** fail the whole run — per `03-module-flow.md` module 13's retry policy, that image slot falls back to "no inline image at that position" (for an inline image) or, for the rare case of the hero image itself failing, routes to `needs_review` rather than publishing without a hero image (since `mainImage` is treated as a hard requirement per the Structured-Data Readiness check). This asymmetry — inline images are soft-degradable, the hero image is not — reflects that a missing inline image is a minor content gap, but a missing hero image breaks the OG/social-share image contract site-wide for that post.

## Logging discipline

Every error, at every level, is logged with: `module`, `runId`, `errorClass`, `attemptNumber`, `providerName` (if applicable), and enough context to reproduce the failure (the input that was passed to the module, truncated if very large) — but **never** the raw API key/token value, even in debug logs. Structured logs (not free-text) so that a future metrics/alerting layer can query by error class and module without log-scraping regex.

## What "graceful degradation" means here (mirroring `lead-store.ts`'s pattern)

`knowledge/utilities.md` documents `src/lib/lead-store.ts` in Blogspage Agency as the reference pattern for "write with graceful degradation if the write token is missing" — logging instead of throwing, and returning a structured `{ success, persisted }` result rather than letting a missing credential crash the whole request. This pipeline mirrors that same philosophy at the orchestrator level: a single module's exhausted-but-non-fatal failure degrades that *run* to `needs_review` rather than crashing the *process* — the orchestrator (and, if batching multiple rows, the batch driver) keeps running other work. The one place this pipeline is intentionally *less* lenient than `lead-store.ts` is Publish itself, where degrading gracefully into "silently skip publishing" without loud notification would be worse than a hard, visible failure — every `needs_review`/`failed` run always triggers Notification (module 21), which itself degrades gracefully (a failed Slack/email delivery is logged, not escalated back into the pipeline).
