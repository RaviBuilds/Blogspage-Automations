# 09 — Provider Abstraction (revised)

> **Revision note (original pass):** The core rule and interface shape from the original pass are unchanged and remain correct — that revision added the fields `15-cost-tracking-system.md` needs (`cachedInputTokens`, `pricingVerifiedAt`), a `supportsCaching` capability flag, and aligned every example with the registry-key naming convention introduced in `13-prompt-management-system.md`.

> **Revision note (Phase 4 pre-implementation pass):** This second revision was made before any provider code exists, following an architecture review requested specifically to catch this kind of gap before implementation rather than after. It adds: reasoning-token accounting (`usage.reasoningTokens`, `LLMCallOptions.reasoningEffort`); an optional per-call `timeoutMs` with documented defaults (`08-retry-strategy.md`); a `ProviderCapabilities` object replacing the three (now four) flat boolean flags; an expanded `ImageGenerateOptions`/`ImageProviderCapabilities` (`n`, `seed`, `quality`, `style`, `size`, `mode`, `sourceImage`); per-model (not per-class) capability resolution for `OpenRouterProvider`/`LocalLLMProvider`; and a new, deliberately consumer-less `ProviderStatus`/`ProviderHealthReporter` interface for future failover/monitoring. **Streaming was considered and explicitly rejected**, not deferred for reconsideration — see "Streaming" below. Every change here is additive or object-shaped-instead-of-flat; the only two other documents with a call site that referenced the old flat booleans by name (`03-module-flow.md`, `13-prompt-management-system.md`) are updated in this same pass to reference the new `capabilities` object instead.

## The rule (unchanged)

No module — no file under `src/modules/` — ever imports an LLM SDK or an image-generation SDK directly. Every module depends only on the `LLMProvider` / `ImageProvider` interface defined in `src/providers/`. The concrete implementation is chosen exactly once, at process configuration time, by `providerFactory.ts` / `imageProviderFactory.ts`, based on `src/config/models.ts`. Changing from Anthropic to OpenAI for the `STANDARD` tier is a one-line config change, with zero edits to any module.

## The `LLMProvider` interface (revised again)

```ts
// src/providers/llm/LLMProvider.ts
interface LLMCallOptions {
  moduleKey: string;             // the calling module's registry key (13-prompt-management-system.md),
                                   // threaded through so the adapter can tag its own CostEvent (15-cost-tracking-system.md)
                                   // without moduleRunner having to reach into adapter internals to attach it after the fact
  systemPrompt: string;
  userPrompt: string;
  responseFormat: 'text' | 'json';
  jsonSchema?: object;
  maxOutputTokens: number;
  images?: { data: string; mimeType: string }[];
  cacheableSystemPromptPrefix?: boolean;   // hint from the caller: "this system prompt is stable across many
                                             // calls, mark it cacheable if this provider supports it." The registry
                                             // sets this automatically for prompts assembled from `shared/*.md`
                                             // fragments (13-prompt-management-system.md) — module code never sets
                                             // this by hand, it flows through from the PromptSet's own metadata.
  timeoutMs?: number;             // NEW — per-call override. Omitted means "use this adapter's configured default"
                                    // (08-retry-strategy.md's DEFAULT_TIMEOUT). A call that exceeds its timeout is
                                    // classified as a retryable ProviderError (07-error-handling.md) — timing out is
                                    // a new trigger for an existing error path, not a new error class.
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';   // NEW — optional hint for reasoning-capable models
                                    // (extended thinking / a "thinking budget" / equivalent). A provider whose
                                    // capabilities.reasoning is false must ignore this field silently rather than
                                    // error — the same "no-op for an unsupported hint" rule already established
                                    // for cacheableSystemPromptPrefix. Omitted is equivalent to 'none'.
}

interface LLMCallResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;    // tokens served from the provider's own prompt cache at cache-read pricing.
                                    // 0 if the provider doesn't support caching or this call didn't hit the cache.
                                    // This is the exact field 15-cost-tracking-system.md's CostEvent needs, and it
                                    // must come from the adapter (the only layer that can read it off the real
                                    // provider response) — moduleRunner cannot compute or infer this after the fact.
    reasoningTokens: number;      // NEW — tokens spent on internal reasoning/thinking, billed separately by
                                    // providers/models that have a native reasoning mode. 0 for a provider/model
                                    // with no reasoning mode, or when reasoningEffort was 'none' or omitted — an
                                    // honest zero, the same convention as cachedInputTokens above. Read directly
                                    // off the real provider response, never estimated.
  };
  costUsd: number;
  pricingVerifiedAt: string;      // ISO date the adapter's own pricing table was last confirmed against the
                                    // provider's real pricing page. Every adapter carries this as a file-level
                                    // constant (see "Adapter responsibilities" below); it rides along on every
                                    // result so a stale pricing table is visible in cost reports, not silently trusted.
  providerName: string;
  modelId: string;
  stopReason: 'complete' | 'maxTokens' | 'refusal' | 'error';
}

interface ProviderCapabilities {     // NEW — replaces the three (now four) flat boolean flags below
  vision: boolean;
  jsonSchema: boolean;
  caching: boolean;
  reasoning: boolean;                // NEW — whether this provider/model has a native reasoning/thinking mode
                                       // that consumes reasoningEffort and reports usage.reasoningTokens
}

interface LLMProvider {
  complete(options: LLMCallOptions): Promise<LLMCallResult>;
  readonly capabilities: ProviderCapabilities;
}
```

Every module that calls an LLM does so through exactly this interface — never through a provider-specific request/response shape. A module needing vision (Image Validator) checks `provider.capabilities.vision` at startup, failing fast with a clear config error rather than discovering the mismatch at call time. This behavior is unchanged from the original design; only the shape of where a capability lives changed, from a same-named top-level boolean to a field on `capabilities`.

**Why a `capabilities` object instead of a fourth top-level boolean:** three flat booleans (`supportsVision`, `supportsJsonSchema`, `supportsCaching`) were manageable; a fourth (`reasoning`) is the point at which that pattern stops scaling cleanly, and streaming/batch/richer-multimodal would each want a fifth and sixth if this pipeline ever added them. Grouping every capability flag under one `capabilities` object means the interface grows by adding a key inside an existing field, not by adding a new top-level property to `LLMProvider` itself — a smaller, more contained change every time a new capability needs representing.

## Why `cachedInputTokens` and `reasoningTokens` belong on the adapter, not computed downstream

`15-cost-tracking-system.md` explains *why* these fields matter (cache tokens: detecting a silent cache-invalidation regression; reasoning tokens: not misattributing separately-billed reasoning cost into `outputTokens`). This document is the place to be precise about *where* they must be captured: the real provider response is the only source of truth for whether a given call hit the cache or how many tokens went to reasoning — no amount of post-hoc estimation from total token counts alone can distinguish these from ordinary output. Every adapter's `complete()` implementation must read both values directly off that provider's own usage/metadata response fields and pass them through unmodified. An adapter that doesn't populate one (because its underlying provider has no caching mechanism, or no reasoning mode) simply returns `0` — that's a legitimate, honest value, not a missing one.

## Call timeouts (NEW)

Every `LLMProvider.complete()` call is bounded by a timeout. `LLMCallOptions.timeoutMs` is optional; when omitted, the adapter falls back to `08-retry-strategy.md`'s `DEFAULT_TIMEOUT` constants in `src/config/pipeline.ts`. A call that exceeds its timeout is classified as a retryable `ProviderError` (`07-error-handling.md`) on the same footing as a network error or a 5xx — timing out is a new *trigger* for the existing provider-transient retry path, not a new error class or a new retry category. `LocalLLMProvider` is the adapter most likely to need a higher-than-default timeout configured, since self-hosted inference latency is hardware-dependent and not bounded by a vendor SLA the way the cloud providers are — `08-retry-strategy.md` names a specific, higher default for it rather than leaving every local deployment to discover this by trial and error.

## Streaming (explicitly rejected for this pipeline, not merely deferred)

Streaming is out of scope for Phase 4 and is not designed anywhere in this interface — no streaming method, flag, or capability field exists. This is a deliberate scope decision, not an oversight: this is a backend automation pipeline with no human watching a live token stream today, and `06-cost-optimization.md` already noted that streaming only reduces *perceived* latency, which has no audience here. If a genuine future need arises (a live-progress dashboard, per `18-scalability-and-future-features.md`'s human-approval-workflow discussion), it is additive — a second method (e.g. `completeStream()`) alongside `complete()` — not a redesign of anything specified in this document. See `12-future-roadmap.md` Part 1 for the named trigger.

## The `ImageProvider` interface (revised)

```ts
// src/providers/image/ImageProvider.ts
interface ImageGenerateOptions {
  moduleKey: string;
  prompt: string;
  aspectRatio: string;
  n?: number;                      // NEW — number of images to request in this single call, default 1. Only
                                     // meaningful where capabilities.batchGeneration (below) is true; an adapter
                                     // that doesn't support multi-image calls ignores values above 1. Whether a
                                     // module actually requests n > 1 (instead of N separate calls, the current
                                     // module-flow design in 03-module-flow.md) is a module-level decision for a
                                     // later phase, not something this interface change makes automatically.
  seed?: number;                   // NEW — deterministic seed, where the provider supports one (see
                                     // capabilities.seeded below); omit for non-deterministic generation.
  quality?: 'standard' | 'high';   // NEW — provider-agnostic quality hint; an adapter maps this onto whatever
                                     // quality/step-count parameter its own provider actually exposes.
  style?: string;                  // NEW — free-form style hint. Provider-specific style vocabulary is translated
                                     // entirely inside the adapter that receives it, never leaked to module code
                                     // (same rule as every other provider-specific detail — see "What must never
                                     // leak through the abstraction" below).
  size?: string;                   // NEW — e.g. '1024x1024'. Adapters that only support aspect-ratio-based sizing
                                     // derive their own size from aspectRatio and ignore this field.
  mode?: 'generate' | 'edit' | 'variation';   // NEW — default 'generate'. 'edit'/'variation' are placeholders:
                                     // declaring the field now avoids a breaking interface change whenever the
                                     // first adapter actually implements one of them; no adapter implements
                                     // anything other than 'generate' in Phase 4.
  sourceImage?: { data: string; mimeType: string };   // NEW — required when mode is 'edit'/'variation', unused
                                     // for 'generate'. Also a placeholder for the same reason as mode above.
  timeoutMs?: number;              // NEW — per-call override, mirroring LLMCallOptions.timeoutMs exactly. Omitted
                                     // means "use this adapter's configured default" (08-retry-strategy.md's
                                     // DEFAULT_TIMEOUT). A call that exceeds its timeout is classified as a
                                     // retryable ProviderError, the same as an LLM call's timeout.
}

interface ImageGenerateResult {
  data: string;
  mimeType: string;
  costUsd?: number;
  pricingVerifiedAt: string;
  providerName: string;
  modelId: string;
}

interface ImageProviderCapabilities {   // NEW — mirrors LLMProvider's capabilities pattern for consistency
  batchGeneration: boolean;             // whether n > 1 is honored in a single call
  editing: boolean;                     // whether mode: 'edit'/'variation' is supported
  seeded: boolean;                      // whether `seed` produces reproducible output
}

interface ImageProvider {
  generate(options: ImageGenerateOptions): Promise<ImageGenerateResult>;
  readonly capabilities: ImageProviderCapabilities;
}
```

Every new field above is optional and every new capability defaults to "not supported" for an adapter that predates it — no existing call shape (a single `generate()` call with `prompt`/`aspectRatio` only) changes meaning.

## Provider Health Monitoring (interface only — no orchestration logic yet)

```ts
// src/providers/shared/ProviderStatus.ts
interface ProviderStatus {
  providerName: string;
  health: 'healthy' | 'degraded' | 'unavailable';
  lastSuccessAt?: string;        // ISO 8601 (lib/dates.ts, 14-core-utilities.md); undefined if never succeeded
  lastFailureAt?: string;        // ISO 8601; undefined if never failed
  lastLatencyMs?: number;        // latency of the most recently completed call, success or failure
  consecutiveFailures: number;   // resets to 0 on any success
  availability: number;          // rolling success ratio over a fixed recent window (e.g. last 20 calls);
                                   // 1.0 if no calls have been recorded yet
  quota?: {                      // NEW, optional — populated only where the provider exposes quota/rate-limit
                                   // information on its response (Anthropic and OpenAI both do; a fully local
                                   // model typically has no meaningful quota concept and legitimately never
                                   // populates this — the same honest-absence convention as cachedInputTokens: 0)
    remaining?: number;
    limit?: number;
    resetAt?: string;            // ISO 8601
  };
}

interface ProviderHealthReporter {
  getStatus(): ProviderStatus;
}
```

Any `LLMProvider`/`ImageProvider` adapter may optionally also implement `ProviderHealthReporter`. An adapter that does tracks its own status entirely locally — updating `lastSuccessAt`/`lastFailureAt`/`lastLatencyMs`/`consecutiveFailures`/`availability` after every `complete()`/`generate()` call, inside that adapter's own instance state, with no shared registry and no cross-adapter aggregation. **This is local bookkeeping, not orchestration:** nothing in `moduleRunner` or the orchestrator reads `ProviderStatus` in Phase 4, and no failover, circuit-breaking, retry-routing, or alerting logic exists yet. `ProviderStatus` is being designed now, deliberately ahead of any consumer, so that a future automated-failover feature (`12-future-roadmap.md`'s deferred list) has a stable, already-adopted interface to build against instead of retrofitting health tracking into five adapters at that later point.

## Adapter responsibilities (revised again)

Each concrete adapter (`AnthropicProvider.ts`, `OpenAIProvider.ts`, `GeminiProvider.ts`, `OpenRouterProvider.ts`, `LocalLLMProvider.ts`) owns:

1. Translating `LLMCallOptions` into that provider's actual request shape — including, where `capabilities.caching` is true, translating `cacheableSystemPromptPrefix: true` into that provider's specific caching mechanism (a no-op if the provider has no equivalent, in which case `capabilities.caching` must honestly report `false`); and, where `capabilities.reasoning` is true, translating `reasoningEffort` into that provider's specific reasoning-mode parameter (a no-op if unsupported, in which case `capabilities.reasoning` must honestly report `false`).
2. Translating that provider's response back into `LLMCallResult`, including `cachedInputTokens` and `reasoningTokens` (both read from the real response) and `costUsd` computed from a **file-level pricing table that lives next to the adapter** (unchanged from the original design), tagged with a `PRICING_VERIFIED_AT` constant that becomes `pricingVerifiedAt` on every result.
3. Mapping that provider's error responses — including a timeout — into the shared `ProviderError` taxonomy (`07-error-handling.md`).
4. Declaring `capabilities` honestly. For `AnthropicProvider`/`OpenAIProvider`/`GeminiProvider` this remains a fixed object literal per class, exactly as it was a fixed set of booleans before — one vendor, one fixed capability set. **For `OpenRouterProvider` and `LocalLLMProvider`, capabilities must be resolved per configured `modelId`, not hardcoded per class** — see below.
5. (Optional) Implementing `ProviderHealthReporter.getStatus()` if that adapter chooses to track its own health locally.

```ts
// src/providers/llm/AnthropicProvider.ts (shape, not full implementation)
const PRICING_VERIFIED_AT = '2026-06-24';   // update this constant whenever the pricing table below is re-checked

class AnthropicProvider implements LLMProvider {
  readonly capabilities: ProviderCapabilities = {
    vision: true,
    jsonSchema: true,
    caching: true,
    reasoning: true,   // Claude's extended-thinking mode
  };

  async complete(options: LLMCallOptions): Promise<LLMCallResult> {
    // translate to Anthropic's Messages API shape (applying a cache-control marker on the
    // system prompt block when options.cacheableSystemPromptPrefix is true, and a thinking-budget
    // parameter when options.reasoningEffort is set and capabilities.reasoning is true), call the
    // SDK with an AbortSignal derived from options.timeoutMs, read usage.cache_read_input_tokens
    // and the thinking-token usage field off the real response into cachedInputTokens/reasoningTokens,
    // compute costUsd from this file's own pricing table, map errors (including abort/timeout) to ProviderError
  }
}
```

### Why `OpenRouterProvider` and `LocalLLMProvider` resolve capabilities per model, not per class

`AnthropicProvider`/`OpenAIProvider`/`GeminiProvider` each map to one vendor with a genuinely fixed capability set — declaring `capabilities` as a class-level constant is accurate for all three. `OpenRouterProvider` and `LocalLLMProvider` are different: OpenRouter's real vision/JSON-schema/caching/reasoning support depends entirely on which underlying `modelId` it's configured to route to, and a self-hosted local model's capabilities depend on whatever model is actually deployed behind `config.localEndpointUrl`. Declaring a single fixed `capabilities` object for either of these two classes would mean it is only accidentally correct for whichever specific model happens to be configured, and silently wrong the next time someone changes `modelId` in config without also remembering to update the class. The fix: both adapters resolve `capabilities` from a small, explicit lookup table keyed by `modelId`, falling back to the most conservative (`{ vision: false, jsonSchema: false, caching: false, reasoning: false }`) capability set for any `modelId` not in the table — an unrecognized model fails closed on capability checks (a clear startup error if a module then requires a capability it doesn't have) rather than silently assuming a capability that isn't really there.

```ts
// src/providers/llm/OpenRouterProvider.ts (shape)
const MODEL_CAPABILITIES: Record<string, ProviderCapabilities> = {
  'anthropic/claude-sonnet-5': { vision: true, jsonSchema: true, caching: true, reasoning: false },
  'openai/o3':                 { vision: false, jsonSchema: true, caching: false, reasoning: true },
  // extend as new routed models are actually used by this project
};
const FALLBACK_CAPABILITIES: ProviderCapabilities = {
  vision: false, jsonSchema: false, caching: false, reasoning: false,
};

class OpenRouterProvider implements LLMProvider {
  readonly capabilities: ProviderCapabilities;

  constructor(private readonly modelId: string, private readonly apiKey: string) {
    this.capabilities = MODEL_CAPABILITIES[modelId] ?? FALLBACK_CAPABILITIES;
  }

  async complete(options: LLMCallOptions): Promise<LLMCallResult> {
    // as AnthropicProvider above, using this.capabilities to decide what to translate
  }
}
```

`LocalLLMProvider` applies the identical pattern, keyed by whatever local model identifier `config.localEndpointUrl`'s deployment reports or is configured with — the mechanism is the same lookup-with-conservative-fallback shape, just a different table.

## Selection: `providerFactory.ts` (unchanged shape, tenant-ready per the scalability review)

```ts
// src/providers/llm/providerFactory.ts
type ModelTier = 'CHEAP' | 'STANDARD' | 'PREMIUM';

function getProvider(tier: ModelTier, config: Config, tenantId?: string): LLMProvider {
  // tenantId is optional and unused in v1 (single-tenant) — its presence here, rather than
  // being added later, is what 18-scalability-and-future-features.md means by "an additive
  // parameter, not a redesign" when multi-tenant per-brand model budgets become real
  const spec = config.models[tier];
  switch (spec.provider) {
    case 'anthropic':  return new AnthropicProvider(spec.modelId, config.anthropicApiKey);
    case 'openai':     return new OpenAIProvider(spec.modelId, config.openaiApiKey);
    case 'gemini':     return new GeminiProvider(spec.modelId, config.geminiApiKey);
    case 'openrouter': return new OpenRouterProvider(spec.modelId, config.openrouterApiKey);
    case 'local':      return new LocalLLMProvider(spec.modelId, config.localEndpointUrl);
  }
}
```

This function remains **the only place** in the codebase where a `switch` on provider name exists.

## `src/config/models.ts` — the tier-to-provider mapping (unchanged)

```ts
interface ModelsConfig {
  CHEAP:    { provider: ProviderName; modelId: string };
  STANDARD: { provider: ProviderName; modelId: string };
  PREMIUM:  { provider: ProviderName; modelId: string };
}

const DEFAULT_MODELS: ModelsConfig = {
  CHEAP:    { provider: 'anthropic', modelId: 'claude-haiku-4-5' },
  STANDARD: { provider: 'anthropic', modelId: 'claude-sonnet-5' },
  PREMIUM:  { provider: 'anthropic', modelId: 'claude-opus-4-8' },
};
```

## How `moduleRunner` uses the revised interface

This is the integration point that makes `15-cost-tracking-system.md`'s `CostEvent` emission concrete rather than aspirational: `core/moduleRunner.ts` calls `provider.complete({ moduleKey: registryKey, ...promptSet, ... })`, and on the returned (or thrown) result, constructs exactly one `CostEvent` per attempt directly from the fields this interface now guarantees exist — `usage.inputTokens`, `usage.outputTokens`, `usage.cachedInputTokens`, `usage.reasoningTokens`, `costUsd`, `pricingVerifiedAt`, `providerName`, `modelId` map onto `CostEvent`'s fields one-to-one, with no translation logic needed in `moduleRunner` itself. This is the payoff of putting these fields on the *interface* rather than leaving each adapter to report cost data in its own shape: the consumer of that data (`moduleRunner`, and transitively the Cost Reporter) never needs provider-specific handling anywhere.

## Local LLM support (unchanged principle, capability resolution revised)

`LocalLLMProvider` targets an OpenAI-compatible local inference server via `config.localEndpointUrl`. Per the capability-resolution change above, it reports `capabilities` from a per-model lookup table rather than a fixed class constant, and honestly reports `caching: false`/`reasoning: false` for any model not known to expose an equivalent — this is a case where honestly reporting a missing capability, per the rule above, is expected and normal, not a gap to apologize for. It also uses a higher default timeout than the cloud adapters (`08-retry-strategy.md`'s `DEFAULT_TIMEOUT.localProviderTimeoutMs`), since self-hosted inference latency is hardware-dependent and not bounded by a vendor SLA.

## Testing implication (revised again)

Because every module depends only on the `LLMProvider`/`ImageProvider` interfaces, unit tests mock them via `FakeLLMProvider`/`FakeImageProvider`. This revision changes the fakes in two mechanical ways: (1) `FakeLLMProvider`'s scripted `LLMCallResult` must now include `usage.reasoningTokens` (hardcoded to `0` for every existing test fixture, since no module under test uses a reasoning-tier model yet — an honest zero, not a placeholder to revisit later) alongside the already-required `cachedInputTokens`/`pricingVerifiedAt`; (2) `FakeLLMProvider`'s constructor now takes a single `capabilities: ProviderCapabilities` object instead of three separate boolean constructor arguments, so any test fixture that previously constructed a fake with individual `supportsVision`/`supportsJsonSchema`/`supportsCaching`-style options needs that one mechanical update to a `capabilities: { vision, jsonSchema, caching, reasoning }` object. Both are one-time updates to the test double's shape, not a new testing concern.

## What must never leak through the abstraction (unchanged, one addition)

- Provider-specific parameter names never appear in `LLMCallOptions`.
- Provider-specific error shapes never reach `moduleRunner` or any module — always normalized to `ProviderError` first.
- Provider-specific model IDs never appear anywhere outside `src/config/models.ts` and the adapter that receives that ID as a constructor argument.
- Provider-specific caching mechanisms (cache-control markers, TTL parameters, etc.) never appear outside the adapter that implements `cacheableSystemPromptPrefix` for that specific provider — the boolean hint is the entire cross-adapter vocabulary for this concept.
- **New:** provider-specific reasoning-mode parameters (a token-count-shaped "thinking budget" for one provider vs. an effort enum for another) never appear outside the adapter that translates `reasoningEffort` for that specific provider — the same rule, one more concept.
