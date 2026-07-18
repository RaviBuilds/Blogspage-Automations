# 06 — Cost Optimization

## Pricing grounding and caveat (read this first)

The per-module cost estimates in `03-module-flow.md` use **Anthropic's current, verified API pricing** as the worked baseline, because that pricing is directly available and confirmed at the time this document was written:

| Tier | Model (Anthropic) | Input $/1M tok | Output $/1M tok |
|---|---|---|---|
| Cheap | Claude Haiku 4.5 | $1.00 | $5.00 |
| Standard | Claude Sonnet 5 | $3.00 ($2.00 intro through 2026-08-31) | $15.00 ($10.00 intro) |
| Premium | Claude Opus 4.8 | $5.00 | $25.00 |

**This system is provider-agnostic by design (`09-provider-abstraction.md`) — it is not committed to Anthropic.** If OpenAI, Gemini, OpenRouter, or a local model is selected for any tier, re-derive the per-module cost estimates from that provider's current published pricing before treating the numbers in `03-module-flow.md` as a real budget. Live web pricing lookups for OpenAI/Gemini during this document's authoring returned no usable data — rather than fabricate numbers for those providers, this document is explicit that Anthropic pricing is the only grounded baseline available right now, and flags every other provider's cost as **illustrative and provider-pricing-page-dependent**, not committed.

Image-generation pricing is even more provider-specific (per-image, not per-token) and is called out per-module in `03-module-flow.md` as a budgeted range ($0.02–$0.08/image) that must be reconciled against whichever image provider is actually configured.

## The core optimization lever: model tiering

Every LLM-calling module is annotated with a tier (`CHEAP` / `STANDARD` / `PREMIUM`) in `03-module-flow.md`, not a hardcoded model. `src/config/models.ts` maps tier → concrete provider+model, so tier assignment is a **content-quality decision made once per module**, and the **provider/model choice underneath it is a config change**, never a module-code change.

### Where premium is actually needed (and where it isn't)

| Module | Tier | Why |
|---|---|---|
| Content Planner | PREMIUM | The outline is the highest-leverage artifact in the pipeline — every downstream module inherits its structure. A weak outline compounds into a weak article no matter how good the writer step is. |
| Article Writer | PREMIUM | The actual reader-facing prose quality is the product. This is the one step users would notice degradation in immediately. |
| Article Improver | PREMIUM | Rare (loop-only) invocation, so premium cost here is low in aggregate, but targeted repairs benefit from the strongest reasoning to avoid introducing new issues while fixing old ones. |
| Research | STANDARD | Needs to be competent, not brilliant — it's gathering/structuring facts, not making creative judgment calls. |
| SEO Planner | STANDARD | Keyword/structure decisions benefit from reasonable judgment but aren't as consequential as the outline itself. |
| Humanizer | STANDARD | A style pass, not a content-creation pass — Sonnet-tier quality is sufficient to remove AI writing tells. |
| Image Validator | STANDARD | Needs vision capability and reasonable judgment, but "does this image match the brief" is a bounded classification task. |
| SEO Reviewer, Technical QA gate, Image Planner, FAQ Generator, Internal Link Generator (LLM path) | CHEAP | All are checklist-style, bounded-output tasks — classification, short list generation, or a rubric-based pass/fail. Haiku-tier quality is sufficient and the cost difference compounds meaningfully at scale (these run every single time; Article Improver only runs sometimes). |
| Technical Reviewer | STANDARD | Needs enough capability to actually catch factual drift against research, which is more than a pure checklist task, but doesn't need premium-level creative judgment. |

**The single biggest cost-tiering decision in this system:** Article Writer and Content Planner are the only two modules that always run at premium tier on every single run. Everything else is either cheap-tier, standard-tier, or premium-tier-but-rare (loop-only). This is deliberate — it concentrates spend where it buys the most reader-visible quality.

## Parallel execution opportunities

Independent LLM/API calls that don't depend on each other's output should run concurrently, not sequentially. Identified in this pipeline:

1. **Image Generator (module 12):** every image in `state.imagePlan.images` is an independent generation call — no image's prompt depends on another image's result. These run in `Promise.all`-style concurrency, not a loop. This is the single biggest latency win in the pipeline (see `11-performance.md` for the latency-specific analysis) and has no cost downside — parallel calls cost the same aggregate tokens/images as sequential ones, just faster.
2. **Image Validator (module 13):** validating each generated image is likewise independent per-image and parallelizes the same way.
3. **Technical Reviewer + SEO Reviewer (modules 6, 7):** both read the same `state.draft` and don't depend on each other's output — they can run concurrently rather than sequentially, provided the orchestrator merges both results before the Humanizer step. This roughly halves the wall-clock cost of the review phase with zero token-cost change.

Explicitly **not** parallelizable: Article Writer must wait for Content Planner + SEO Planner + Research (real data dependency); Humanizer must wait for both reviewers (needs to know what not to undo); Sanity Document Builder must wait for every content-producing module (it assembles the final artifact).

## Caching opportunities

- **Prompt caching (provider-native):** Every LLM call in this pipeline that shares a stable system prompt across many invocations (e.g. every Article Writer call uses the same `system.md` + `_shared/brand-voice.md`) should mark that stable prefix as cacheable when the underlying provider supports it (Anthropic's `cache_control: {type: "ephemeral"}` is the concrete mechanism if Anthropic is the configured provider for that tier — see the Anthropic skill's prompt-caching guidance for placement rules; other providers have their own equivalent or none at all, handled inside that provider's adapter, never in module code). This is a genuine win specifically for high-volume modules like Article Writer, SEO Reviewer, and Technical QA gate, which share large, unchanging system prompts across every run.
- **Existing-posts list caching (module 4, SEO Planner):** the list of existing published post titles/slugs used as internal-link candidates changes slowly (only when new posts publish) — cache it in `stateStore` or a short-TTL in-memory cache rather than re-querying Sanity on every run.
- **No caching of the actual content-generation output** — every article is meant to be unique; caching is about the *scaffolding* around calls (system prompts, reference data), never about reusing a previous run's generated content for a different topic.

## Batch opportunities

This pipeline is currently designed for **one post per run**, triggered per Sheet row. If the automation later needs to process many pending Sheet rows in one invocation (a legitimate near-term need — see `12-future-roadmap.md`), two batching strategies apply without changing per-module logic:

1. **Pipeline-level batching:** run N independent pipeline instances concurrently (bounded by a concurrency limit to respect provider rate limits), each with its own `PipelineState` — this is orchestration-level parallelism, not a module change.
2. **Provider-level batch APIs:** for a large backlog of rows where latency doesn't matter (e.g. an overnight catch-up run), Research/Content Planner/SEO Planner calls for many rows could be submitted through the configured provider's batch endpoint (where one exists, e.g. Anthropic's Message Batches API) at roughly half the standard per-token cost — this is a `06`-level optimization to schedule when volume justifies the added complexity of the async batch-result-polling flow, not a v1 requirement.

## Streaming opportunities

Streaming reduces perceived latency, not cost, but is worth noting for module 5 (Article Writer) specifically: it's the single longest-generation module in the pipeline (target ~2,800 output tokens). If Notification or a future dashboard ever surfaces live progress to a human watching a run, Article Writer is the module to stream — everywhere else in the pipeline, output is short enough that streaming adds complexity without a perceptible benefit.

## Token reduction techniques

- **Article Improver's targeted-repair prompt design** (`05-prompt-strategy.md`) is itself a token-reduction technique — instructing "smallest edit that resolves the issue, preserve everything else" keeps output length close to input length rather than paying for a full regeneration on every loop iteration.
- **SEO Planner's existing-posts list** should be trimmed to title+slug only (not full post content) before it's included in that module's prompt — a projection query, not a full document fetch.
- **Research module's output feeds every downstream generative step** (`state.research` is read by modules 3, 5, 6). Keep `keyFacts`/`candidateStatistics` concise and structured rather than verbose prose, since this field's token cost is paid repeatedly across every module that reads it as context.

## JSON compression

Every module that emits structured JSON output (the majority of LLM-calling modules — see `04-json-contracts.md`) should use short, non-redundant field names in its own internal schema where the schema is purely internal-pipeline (not user-facing and not the final Sanity document shape, which must match `automation-integration.md` exactly and is not up for renaming). This is a minor win compared to model-tiering but costs nothing to apply consistently. The bigger JSON-related cost lever is **`output_config.format` / structured-output enforcement** where the configured provider supports it (see `09-provider-abstraction.md`) — this eliminates the token overhead of markdown code-fence wrapping and reduces the retry rate from malformed JSON, which is a real, recurring cost (`08-retry-strategy.md`) more than a token-count-per-call cost.

## Prompt reuse

- `_shared/brand-voice.md` and `_shared/output-format-json.md` (see `05-prompt-strategy.md`) are the concrete reuse mechanism — one fragment, included everywhere it's needed, rather than the same boilerplate duplicated (and drifting) across a dozen `system.md` files.
- The four review-family modules (Technical Reviewer, SEO Reviewer, Technical QA gate, Image Validator) share a common "return a structured pass/fail with an issue list" output contract — this shared shape is defined once in `_shared/output-format-json.md`'s review variant and reused, rather than each module inventing its own slightly-different pass/fail JSON shape.

## Estimated cost per run (Anthropic baseline, grounded)

Summing the per-module figures from `03-module-flow.md` (LLM-bearing modules only, no loop retries, image-gen mid-range at $0.05/image × 3 images):

| Category | Cost |
|---|---|
| Research | $0.016 |
| Content Planner | $0.027 |
| SEO Planner | $0.008 |
| Article Writer | $0.083 |
| Technical Reviewer | $0.014 |
| SEO Reviewer | $0.005 |
| Humanizer | $0.078 |
| Technical QA gate | $0.002 |
| Image Planner | $0.004 |
| Image Generation (3 images @ $0.05) | $0.150 |
| Image Validation (3 images) | $0.012 |
| Internal Link Generator | $0.001 |
| FAQ Generator | $0.004 |
| **Total (no loop retries)** | **≈ $0.404/run** |

With one review-loop iteration (Article Improver invoked once): add ≈$0.081 → **≈ $0.485/run**. At 30 posts/month, that's roughly **$12–$15/month** in LLM+image spend on the Anthropic baseline — small enough that the tiering decisions above matter more for *quality consistency* than for raw dollar savings at this volume, but the same tiering discipline is what keeps costs proportional if volume grows 10–50x.
