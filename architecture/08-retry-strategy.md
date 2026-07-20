# 08 — Retry Strategy (revised)

> **Revision note (Phase 4 pre-implementation pass):** Adds a "Timeouts" section with `DEFAULT_TIMEOUT` constants and confirms explicitly that a timed-out call is a trigger for the existing provider-transient retry path (`09-provider-abstraction.md`'s new `LLMCallOptions.timeoutMs`), not a new retry category. Nothing else in this document changes.

## Where retries live

All retry logic is centralized in `src/core/moduleRunner.ts` — the wrapper every module call passes through. No module implements its own retry loop. This is what makes retry policy consistent and auditable: one place to read, one place to change.

```ts
interface RetryPolicy {
  maxAttempts: number;
  backoff: 'exponential' | 'none';
  baseDelayMs: number;
  retryOn: ('providerTransient' | 'schemaValidation')[];
}
```

Each module declares its own `RetryPolicy` (documented per-module in `03-module-flow.md`'s "Retry policy" field) and `moduleRunner` enforces it uniformly.

## Two fundamentally different retry conditions

This pipeline distinguishes two retry triggers that are handled differently, because they have different causes and different fixes:

### 1. Provider-transient retries (network/rate-limit/5xx)

Triggered by `ProviderError` where `retryable: true` — connection errors, 429, 5xx, request timeout. The retry is a **verbatim re-send of the same request** with exponential backoff (`baseDelayMs * 2^attempt`, capped at a max delay, plus jitter to avoid thundering-herd retries when a batch of pipeline runs hits a rate limit simultaneously). Nothing about the prompt or input changes between attempts — the assumption is the request was fine, the provider was momentarily unavailable.

```
attempt 1 → fail (429) → wait ~1s (+jitter) → attempt 2 → fail (429) → wait ~2s (+jitter) → attempt 3 → success
```

Non-retryable provider errors (401, 403, 400 on a malformed request that isn't a schema-validation case) are **never** retried under this policy — see `07-error-handling.md`, these escalate straight to `FatalError`.

### 2. Schema-validation retries (re-prompt with feedback)

Triggered by `ValidationError` — the call succeeded, but the model's output didn't match the expected schema (malformed JSON, missing required field, an enum value outside the allowed set, a hard business rule violated like `excerpt` outside 50–200 chars). Retrying verbatim would almost certainly reproduce the same failure. Instead, the retry **appends the specific validation failure to the next prompt** as additional context:

```
attempt 1 → model returns excerpt at 42 chars (below 50 minimum)
  → ValidationError: "excerpt must be 50-200 chars, got 42"
attempt 2 → same user.md + system.md, PLUS an appended note:
  "Your previous output failed validation: excerpt must be 50-200 chars,
   got 42 chars ('...'). Regenerate with excerpt corrected to that range."
  → model returns excerpt at 130 chars → passes
```

This is why every generative/review module documents a `validation.md` or an equivalent rubric in `05-prompt-strategy.md` — that same rubric text is reused as the basis for the re-prompt feedback message, so the model is told exactly what it violated, not just "try again."

## Max attempts per module type

| Module type | Max attempts | Rationale |
|---|---|---|
| Deterministic/no-LLM modules (Sheet Reader row parse, Image Upload, Sanity Document Builder assembly) | 3, provider-transient only | No schema-validation retry path exists — if the *code* produces invalid output, that's a bug, not a retry condition. |
| Generative LLM modules (Research, Content Planner, SEO Planner, Article Writer, Humanizer, Image Planner, FAQ Generator) | 2 | Schema-validation failures on a well-specified structured-output call are rare; if it fails twice, the input is more likely malformed than the model being unlucky — escalate rather than burn a third attempt. |
| Review/QA modules (Technical Reviewer, SEO Reviewer, Technical QA gate) | 2 | Same reasoning — these are shorter, more mechanical outputs, two attempts is generous. |
| Article Improver | 2 | Same as generative modules. |
| Image Generator | 3 **per image, independently** | Image generation has a higher inherent failure/quality-variance rate than text generation, and each image is cheap enough in isolation to justify one extra attempt before falling back (per `07-error-handling.md`'s image-loop partial-failure policy). |
| Image Validator | Not retried itself — a validator failing to *run* (provider error) gets 2 attempts; a validator *correctly reporting* an image failed validation is not a retry condition for the validator, it's a trigger to retry the *generator* (see the image loop in `03-module-flow.md`). |
| Publish | 3, provider-transient only, gated by the idempotency check in `07-error-handling.md` before every retry | Side-effecting; must never retry blindly. |

## Backoff parameters (defaults, tunable in `src/config/pipeline.ts`)

```ts
const DEFAULT_BACKOFF = {
  baseDelayMs: 500,
  maxDelayMs: 8000,
  jitterRatio: 0.2,     // ±20% randomization to avoid synchronized retries across parallel image calls
};
```

Applied only to provider-transient retries. Schema-validation retries have **no backoff delay** — the failure isn't rate/load-related, so waiting doesn't help; the retry re-prompts immediately.

## Timeouts (NEW)

Every provider call is bounded by a timeout, sourced from `LLMCallOptions.timeoutMs`/`ImageGenerateOptions`'s equivalent (`09-provider-abstraction.md`) when a caller supplies one, or from these per-provider-class defaults otherwise:

```ts
const DEFAULT_TIMEOUT = {
  anthropicTimeoutMs: 60_000,
  openAiTimeoutMs: 60_000,
  geminiTimeoutMs: 60_000,
  openRouterTimeoutMs: 60_000,
  localProviderTimeoutMs: 180_000,   // self-hosted inference latency is hardware-dependent and not
                                       // bounded by a vendor SLA the way the four cloud adapters are —
                                       // a materially higher default avoids every local deployment
                                       // independently rediscovering that 60s is too aggressive.
};
```

A call that exceeds its timeout is classified as a retryable `ProviderError` (`07-error-handling.md`), on the same footing as a network error or a 5xx, and re-enters the exact provider-transient retry path described above (`baseDelayMs * 2^attempt` backoff, capped, jittered). **This is not a new retry category** — a timeout is simply one more concrete trigger for the retry policy that already exists for `ProviderError`s with `retryable: true`. If a call keeps timing out across every attempt, it exhausts and escalates to `FatalError` exactly the way an exhausted 429/5xx retry does.

## Bounded loops are a retry-adjacent but distinct concept

The review loop (modules 6→10, max 3 iterations) and the image loop (module 12↔13, max 2 retries per image) are **not** `moduleRunner`-level retries — they're orchestrator-level bounded revision cycles, because each iteration is a materially different call (different remaining issues, or the same image prompt re-attempted after a validation failure) rather than a verbatim or feedback-appended re-send of the *same* module call. The distinction matters operationally: a `moduleRunner` retry is invisible outside logging (the module "just succeeded, eventually"), while a review-loop iteration changes `PipelineState.reviewLoop.iteration` and is visible to the orchestrator's routing logic. Both share the same underlying principle — bounded, never infinite, always fail-closed on exhaustion — but they are implemented at different layers and must not be confused when reading `core/moduleRunner.ts` vs `core/orchestrator.ts`.

## What is never retried

- Config/startup validation failures (missing env var) — fatal at process start, not a per-module condition.
- Non-retryable provider errors (401/403, or a 400 that isn't a schema-validation case, e.g. an actually malformed request due to a code bug).
- Notification delivery failures beyond their own small retry budget (2 attempts) — a failed notification must never be allowed to re-trigger or block the pipeline itself.
- Anything after `FatalError` has already been raised for a given run — a `FatalError` is terminal for that run; the *next* Sheet row still gets a fresh run.
