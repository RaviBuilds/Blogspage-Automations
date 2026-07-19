# 15 — Cost Tracking System

## Relationship to `06-cost-optimization.md`

That document answers "where should money be spent, and how do we minimize it" — a design-time question, answered with model tiers, parallelism, and caching strategy. This document answers a different, run-time question: **"how do we know, after the fact, what a run actually cost, broken down by module, provider, and model"** — without that answer, every tiering decision in `06-cost-optimization.md` is an untested hypothesis. Cost tracking is the feedback loop that makes cost optimization an empirical practice instead of a one-time guess.

## Why this needs to be provider-agnostic by construction, not by convention

`09-provider-abstraction.md` already established that `LLMCallResult` carries a `costUsd` field, computed by each adapter from its own pricing table. That was sufficient for a rough per-module estimate in `06-cost-optimization.md`, but it is not sufficient for a real cost-tracking *system*, because a single `costUsd` number loses information a commercial platform needs: was this call cheap because it was small, or because it hit a cache? How many tokens were actually billed vs. estimated? How much did retries add? The fix is to capture the raw components at the source (the provider adapter, since it's the only place that has them) and let a separate reporting layer compute cost views from those components — never the reverse.

## The `CostEvent` — the atomic unit of cost tracking

Every single LLM or image-generation call, successful or failed, retried or not, emits exactly one `CostEvent` per attempt (not per logical module invocation — a module that retries twice emits three `CostEvent`s, one per attempt, so retry cost is visible rather than absorbed into a single averaged number):

```ts
interface CostEvent {
  runId: string;                    // ties back to PipelineState.metadata.runId
  moduleKey: string;                // the same registry key used by the Prompt Registry (13-prompt-management-system.md)
                                     // — one shared vocabulary for "which module" across prompts, logs, and cost, not three
  attemptNumber: number;             // 1-indexed; matches 08-retry-strategy.md's attempt counting
  timestamp: string;                 // ISO 8601, from lib/dates.ts (14-core-utilities.md)
  provider: string;                  // 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'local'
  modelId: string;                   // the concrete model string actually used
  promptVersion?: string;            // the repository HEAD short commit hash at call time, from 13-prompt-management-system.md's PromptSet — a repository-wide value (not folder-specific), so every module call within the same run shares the same value
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;         // tokens served from the provider's own prompt cache, at cache-read pricing — 0 if unsupported/unused
  estimatedCostUsd: number;          // computed by the adapter from ITS OWN pricing table, tagged with pricingVerifiedAt (below)
  pricingVerifiedAt: string;         // date the adapter's pricing table was last confirmed against the provider's real pricing page
  latencyMs: number;
  outcome: 'success' | 'providerError' | 'validationError' | 'timeout';
  isImageGeneration: boolean;        // image calls are priced per-image, not per-token — see "Image cost" below
}
```

This is emitted by `core/moduleRunner.ts` (the same wrapper that already owns retry logic per `08-retry-strategy.md`) immediately after every provider call returns, whether it succeeded or failed — `moduleRunner` is the one place every call already passes through, so it's the correct, single emission point. No module emits its own `CostEvent`; modules never see this type at all, the same way they never see raw provider responses (`09-provider-abstraction.md`).

## Why `cachedInputTokens` is its own field, not folded into cost

`06-cost-optimization.md` names prompt caching as a real, active cost lever (large shared system prompts on high-volume modules). If cache-read tokens are folded into a single `estimatedCostUsd` number, a report showing "Article Writer costs $0.08/run" can't answer "is caching actually working, or did we silently start missing the cache after a prompt edit invalidated the prefix" (a documented risk in the Claude API skill's own prompt-caching guidance: a silent invalidator makes `cache_read_input_tokens` drop to zero with no error, no warning — the exact failure mode this field exists to catch). Recording `cachedInputTokens` explicitly, per call, means the Cost Reporter can show a cache-hit-rate trend over time and flag the regression the day it happens, not months later when someone happens to notice the monthly bill crept up.

## Image generation cost

Image providers are typically priced per-image, not per-token (`06-cost-optimization.md` already flags this). `CostEvent.isImageGeneration: true` calls carry `inputTokens: 0, outputTokens: 0, cachedInputTokens: 0`, and `estimatedCostUsd` set directly from the image adapter's own per-image price — the schema doesn't need a separate image-cost type, it just leaves the token fields at zero and lets `estimatedCostUsd` carry the number, keeping one event shape for both LLM and image calls rather than a second parallel schema.

## Storage: append, never mutate

`CostEvent`s are appended to a per-run cost log (`state.metrics.costEvents: CostEvent[]` — see the revised `PipelineState` in the companion update to `04-json-contracts.md`) as they occur, and also appended to a **process-wide, cross-run** append-only log (`storage/costs/YYYY-MM-DD.jsonl`, one `CostEvent` per line) so historical reporting doesn't require reloading every past run's full `PipelineState` from `stateStore` just to answer a cost question. This mirrors the same "logs are append-only, state is authoritative for the run, but a separate index exists for cheap historical querying" pattern already implicit in `07-error-handling.md`'s logging discipline — made explicit here because cost data specifically needs to be queried in aggregate (by day, by module, by tier) in a way individual run logs aren't optimized for.

## The Cost Reporter

A reporting layer (`src/reporting/costReporter.ts`) that consumes `CostEvent[]` — either from one run's `state.metrics.costEvents` or from the cross-run `storage/costs/` log across a date range — and produces the exact per-module breakdown the refinement request asked for:

```
Cost Report — run a1b2c3d4 (2026-07-17)
─────────────────────────────────────────────
Module              Calls  Retries  In Tok   Out Tok  Cached   Cost
research               1      0      1,200      900        0   $0.016
planner                1      0      1,800      700        0   $0.027
seo-planner            1      0      1,000      400        0   $0.008
writer                 1      0      2,500    2,800      512   $0.082
reviewer-technical     1      0      3,200      500      800   $0.013
reviewer-seo           1      0      2,800      350      800   $0.005
humanizer               1      0      2,900    2,900      512   $0.077
qa                     1      0      1,200      150        0   $0.002
image-planner          1      0      1,500      500        0   $0.004
image-generator        3      0          -        -        -   $0.150
image-validator        3      0        2,400      450        0   $0.012
internal-links         1      0        400      100        0   $0.001
faq-generator          1      0      1,800      400        0   $0.004
─────────────────────────────────────────────
TOTAL                 17      0     22,700   10,150    2,624   $0.401
```

The reporter is deliberately a thin, pure transformation (`CostEvent[]` → report rows) — it never queries a provider, never depends on `LLMProvider`/`ImageProvider`, and lives in `src/reporting/`, not `src/lib/`, because it has a genuine (if simple) output-formatting responsibility rather than being a zero-dependency pure utility (the distinction `14-core-utilities.md` draws between `src/lib/` and everything else). This is what makes the reporter usable identically whether the underlying calls were Anthropic, OpenAI, Gemini, OpenRouter, or local — it never inspects `provider` except to group by it, exactly as the refinement request specified ("the reporting system should work regardless of provider").

### Report views

- **Per-run** (shown above) — the report attached to every Notification (`03-module-flow.md` module 21), so a human sees exact cost alongside every publish/needs-review outcome, not just aggregate monthly spend discovered later.
- **Per-day / per-week / per-month** — aggregated from `storage/costs/*.jsonl` across a date range, grouped by module and by provider — this is what turns `06-cost-optimization.md`'s tiering assumptions into a checkable trend line (e.g. "is Humanizer's real-world cost matching its estimate, or has draft length crept up over time").
- **Per-provider** — the same data grouped by `provider` instead of `moduleKey`, which is the concrete artifact that makes a future provider-swap decision (`09-provider-abstraction.md`) evidence-based: "Anthropic Sonnet-tier is costing us $X/month at this volume; here's what OpenAI/Gemini would cost for the same token volume at their current published pricing" is a real comparison this data supports, not a guess.

## What this system explicitly does not do (v1 scope)

- **No live budget alarms/circuit-breakers** (e.g. "stop the pipeline if monthly spend exceeds $X") — that's a policy decision layered on top of data this system already collects, and belongs in `12-future-roadmap.md`'s post-v1 list once real spend data exists to set a sane threshold against, not designed speculatively now.
- **No per-tenant cost attribution** — irrelevant until multi-tenancy exists (`18-scalability-and-future-features.md`); the schema's `runId`-and-`moduleKey` grouping is deliberately the minimum needed for v1, extended with a `tenantId` field on `CostEvent` only when multi-tenancy is actually built (a additive, non-breaking schema change, not a redesign — see that document's "why this doesn't require a rewrite" reasoning).
- **No pricing auto-fetch from provider APIs** — `pricingVerifiedAt` is a manually-maintained field per adapter (`09-provider-abstraction.md`'s `PRICING_VERIFIED_AT` constant), not a live lookup. Automating that lookup is a reasonable future addition but adds a dependency (scraping or an undocumented pricing API) not justified at v1 volume.
