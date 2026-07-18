# 09 — Provider Abstraction (revised)

> **Revision note:** The core rule and interface shape from the original pass are unchanged and remain correct — this revision adds the fields `15-cost-tracking-system.md` needs (`cachedInputTokens`, `pricingVerifiedAt`), a `supportsCaching` capability flag, and aligns every example with the registry-key naming convention introduced in `13-prompt-management-system.md`. Nothing here contradicts the original design; it closes gaps the later documents surfaced.

## The rule (unchanged)

No module — no file under `src/modules/` — ever imports an LLM SDK or an image-generation SDK directly. Every module depends only on the `LLMProvider` / `ImageProvider` interface defined in `src/providers/`. The concrete implementation is chosen exactly once, at process configuration time, by `providerFactory.ts` / `imageProviderFactory.ts`, based on `src/config/models.ts`. Changing from Anthropic to OpenAI for the `STANDARD` tier is a one-line config change, with zero edits to any module.

## The `LLMProvider` interface (revised)

```ts
// src/providers/llm/LLMProvider.ts
interface LLMCallOptions {
  moduleKey: string;             // NEW — the calling module's registry key (13-prompt-management-system.md),
                                   // threaded through so the adapter can tag its own CostEvent (15-cost-tracking-system.md)
                                   // without moduleRunner having to reach into adapter internals to attach it after the fact
  systemPrompt: string;
  userPrompt: string;
  responseFormat: 'text' | 'json';
  jsonSchema?: object;
  maxOutputTokens: number;
  images?: { data: string; mimeType: string }[];
  cacheableSystemPromptPrefix?: boolean;   // NEW — hint from the caller: "this system prompt is stable across many
                                             // calls, mark it cacheable if this provider supports it." The registry
                                             // sets this automatically for prompts assembled from `shared/*.md`
                                             // fragments (13-prompt-management-system.md) — module code never sets
                                             // this by hand, it flows through from the PromptSet's own metadata.
}

interface LLMCallResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;    // NEW — tokens served from the provider's own prompt cache at cache-read pricing.
                                    // 0 if the provider doesn't support caching or this call didn't hit the cache.
                                    // This is the exact field 15-cost-tracking-system.md's CostEvent needs, and it
                                    // must come from the adapter (the only layer that can read it off the real
                                    // provider response) — moduleRunner cannot compute or infer this after the fact.
  };
  costUsd: number;
  pricingVerifiedAt: string;      // NEW — ISO date the adapter's own pricing table was last confirmed against the
                                    // provider's real pricing page. Every adapter carries this as a file-level
                                    // constant (see "Adapter responsibilities" below); it rides along on every
                                    // result so a stale pricing table is visible in cost reports, not silently trusted.
  providerName: string;
  modelId: string;
  stopReason: 'complete' | 'maxTokens' | 'refusal' | 'error';
}

interface LLMProvider {
  complete(options: LLMCallOptions): Promise<LLMCallResult>;
  supportsVision: boolean;
  supportsJsonSchema: boolean;
  supportsCaching: boolean;        // NEW — whether this provider has any native prompt-caching mechanism at all.
                                     // A module never checks this directly (only the registry/adapter care), but it's
                                     // part of the interface contract because 06-cost-optimization.md's caching
                                     // strategy is a real, active lever that needs a queryable capability flag, the
                                     // same way vision and JSON-schema support already had one.
}
```

Every module that calls an LLM does so through exactly this interface — never through a provider-specific request/response shape. A module needing vision (Image Validator) checks `provider.supportsVision` at startup, failing fast with a clear config error rather than discovering the mismatch at call time. This behavior is unchanged; only the interface's field list grew.

## Why `cachedInputTokens` belongs on the adapter, not computed downstream

`15-cost-tracking-system.md` explains *why* this field matters (it's the only way to detect a silent cache-invalidation regression). This document is the place to be precise about *where* it must be captured: the real provider response is the only source of truth for whether a given call actually hit the cache — no amount of post-hoc estimation from token counts alone can distinguish "this call was small" from "this call was large but mostly cached." Every adapter's `complete()` implementation must read this value directly off that provider's own usage/metadata response fields and pass it through unmodified. An adapter that doesn't populate this (because its underlying provider has no caching mechanism at all) simply returns `0` — that's a legitimate, honest value, not a missing one.

## The `ImageProvider` interface (unchanged)

```ts
// src/providers/image/ImageProvider.ts
interface ImageGenerateOptions {
  moduleKey: string;    // NEW, same reasoning as LLMCallOptions.moduleKey above
  prompt: string;
  aspectRatio: string;
}

interface ImageGenerateResult {
  data: string;
  mimeType: string;
  costUsd?: number;
  pricingVerifiedAt: string;   // NEW, same reasoning as LLMCallResult above
  providerName: string;
  modelId: string;
}

interface ImageProvider {
  generate(options: ImageGenerateOptions): Promise<ImageGenerateResult>;
}
```

## Adapter responsibilities (revised)

Each concrete adapter (`AnthropicProvider.ts`, `OpenAIProvider.ts`, `GeminiProvider.ts`, `OpenRouterProvider.ts`, `LocalLLMProvider.ts`) owns:

1. Translating `LLMCallOptions` into that provider's actual request shape — including, where `supportsCaching` is true, translating `cacheableSystemPromptPrefix: true` into that provider's specific caching mechanism (e.g. a cache-control marker on the system prompt block, if the configured provider is Anthropic and exposes one; a no-op if the provider has no equivalent, in which case `supportsCaching` must honestly report `false` rather than accepting the hint and doing nothing with it).
2. Translating that provider's response back into `LLMCallResult`, now including `cachedInputTokens` (read from the real response) and `costUsd` computed from a **file-level pricing table that lives next to the adapter** (unchanged from the original design), tagged with a `PRICING_VERIFIED_AT` constant that becomes `pricingVerifiedAt` on every result — this is the concrete implementation of the caveat `06-cost-optimization.md` already stated in prose ("re-derive non-Anthropic pricing before trusting it"): the date is now a machine-readable field flowing all the way into cost reports, not just a warning in a document.
3. Mapping that provider's error responses into the shared `ProviderError` taxonomy (`07-error-handling.md`) — unchanged.
4. Declaring `supportsVision`/`supportsJsonSchema`/`supportsCaching` honestly — unchanged principle, one more flag.

```ts
// src/providers/llm/AnthropicProvider.ts (shape, not full implementation)
const PRICING_VERIFIED_AT = '2026-06-24';   // update this constant whenever the pricing table below is re-checked

class AnthropicProvider implements LLMProvider {
  supportsVision = true;
  supportsJsonSchema = true;
  supportsCaching = true;

  async complete(options: LLMCallOptions): Promise<LLMCallResult> {
    // translate to Anthropic's Messages API shape (applying a cache-control marker on the
    // system prompt block when options.cacheableSystemPromptPrefix is true), call the SDK,
    // read usage.cache_read_input_tokens off the real response into cachedInputTokens,
    // compute costUsd from this file's own pricing table, map errors to ProviderError
  }
}
```

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

This is the integration point that makes `15-cost-tracking-system.md`'s `CostEvent` emission concrete rather than aspirational: `core/moduleRunner.ts` calls `provider.complete({ moduleKey: registryKey, ...promptSet, ... })`, and on the returned (or thrown) result, constructs exactly one `CostEvent` per attempt directly from the fields this interface now guarantees exist — `usage.inputTokens`, `usage.outputTokens`, `usage.cachedInputTokens`, `costUsd`, `pricingVerifiedAt`, `providerName`, `modelId` map onto `CostEvent`'s fields one-to-one, with no translation logic needed in `moduleRunner` itself. This is the payoff of putting these fields on the *interface* rather than leaving each adapter to report cost data in its own shape: the consumer of that data (`moduleRunner`, and transitively the Cost Reporter) never needs provider-specific handling anywhere.

## Local LLM support (unchanged)

`LocalLLMProvider` targets an OpenAI-compatible local inference server via `config.localEndpointUrl`. It reports `supportsCaching: false` unless the specific local server exposes an equivalent (rare) — this is a case where honestly reporting a missing capability, per the rule above, is expected and normal, not a gap to apologize for.

## Testing implication (unchanged, extended)

Because every module depends only on the `LLMProvider` interface, unit tests mock that interface via `FakeLLMProvider`. The revised interface means `FakeLLMProvider`'s scripted results must now include `cachedInputTokens` and `pricingVerifiedAt` (even if hardcoded to `0` and a fixed test date respectively) so that tests exercising `moduleRunner`'s cost-event emission path have realistic fixtures to assert against — a one-time update to the test double, not a new testing concern.

## What must never leak through the abstraction (unchanged)

- Provider-specific parameter names never appear in `LLMCallOptions`.
- Provider-specific error shapes never reach `moduleRunner` or any module — always normalized to `ProviderError` first.
- Provider-specific model IDs never appear anywhere outside `src/config/models.ts` and the adapter that receives that ID as a constructor argument.
- **New:** provider-specific caching mechanisms (cache-control markers, TTL parameters, etc.) never appear outside the adapter that implements `cacheableSystemPromptPrefix` for that specific provider — the boolean hint is the entire cross-adapter vocabulary for this concept.
