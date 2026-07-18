# 03 — Module Flow (revised)

> **Revision note:** Content, purpose, dependencies, retry policy, validation rules, and cost estimates for every module are **unchanged** from the original pass — this refinement did not find a reason to alter what any module does. What changed: (1) every module now carries its **registry key** (`13-prompt-management-system.md` / `02-folder-structure.md`'s renamed folders) alongside its descriptive name, (2) every "Inputs"/"Outputs" reference uses the revised nested `PipelineState` paths from `04-json-contracts.md` instead of the old flat keys, (3) module 19 is renamed **Sanity Document Builder** consistently (folder rename `19-sanity-upload` → `sanity-builder`, correcting a name that implied an upload it doesn't perform), and (4) a new module, **Cost Reporter**, is added to the infrastructure section, formalizing `15-cost-tracking-system.md`'s reporting layer as a pipeline-visible step rather than an implicit side effect of Notification.

Model-tier names (`CHEAP` / `STANDARD` / `PREMIUM`) resolve to a concrete provider+model via `src/config/models.ts` — see `09-provider-abstraction.md`. Cost estimates use current, verified Anthropic pricing as the worked baseline (Opus 4.8 $5/$25 per 1M input/output, Sonnet 5 $3/$15 — $2/$10 intro through 2026-08-31, Haiku 4.5 $1/$5 per 1M). If a different provider is selected for a tier, re-derive these numbers from that provider's current pricing before treating them as committed — see `06-cost-optimization.md` and `15-cost-tracking-system.md`'s `pricingVerifiedAt` field, which now makes this caveat machine-checkable, not just a documentation warning.

Every module receives `PipelineState` and writes to exactly the section/field named in its "Outputs" below, matching the ownership table in `04-json-contracts.md` row-for-row.

---

## Pipeline infrastructure (not content modules, but required for completeness)

### Config/Env Loader
- **Purpose:** Load and validate all required environment variables once, at process start; fail fast rather than surfacing a missing key as a cryptic downstream failure.
- **Inputs:** `process.env`
- **Outputs:** a typed, frozen `Config` object passed to the orchestrator (process-level, not part of `PipelineState`)
- **Dependencies:** none
- **Prompt file:** n/a — **LLM used:** none — **Retry policy:** none (fatal startup error, not retryable)
- **Validation:** every required key from `.env.example` present and non-empty
- **Estimated token usage / cost:** 0 / $0

### Orchestrator
- **Purpose:** Runs the module sequence in dependency order (`17-module-dependency-diagram.md`), persists `PipelineState` after every module via `core/stateStore.ts`, drives the two bounded revision loops, and owns every write to `metadata.status` and `review.loop.iteration` — the only two fields in the revised schema the orchestrator itself writes (`04-json-contracts.md`'s ownership table).
- **Inputs:** initial `PipelineState` seed or a resumed state from `stateStore`
- **Outputs:** final `PipelineState` + a run summary for Notification and the Cost Reporter
- **Dependencies:** all modules, `core/moduleRunner.ts`, `core/stateStore.ts`
- **Prompt file:** n/a — **LLM used:** none — **Retry policy:** delegates per-module retry to `moduleRunner`; never auto-retries a whole failed run
- **Validation:** checks each module's own validation result before advancing
- **Estimated token usage / cost:** 0 / $0

### Logging
- **Purpose:** Structured, per-module log lines, appended to `logs/` (per the revised `02-folder-structure.md`) — cross-cutting, invoked by `moduleRunner` around every module call.
- **Inputs:** module registry key, timing, token/cost data from the provider response
- **Outputs:** log lines (not part of `PipelineState`)
- **Dependencies:** none — **Prompt file:** n/a — **LLM used:** none — **Retry policy:** none (must never throw)
- **Estimated token usage / cost:** 0 / $0

### Metrics
- **Purpose:** Aggregate per-run counters/timers by appending to `PipelineState.metrics`, `errors`, and `timings` (the three always-present, append-only sections in the revised schema — `04-json-contracts.md`).
- **Inputs:** the same per-call data Logging sees, plus every `CostEvent` `moduleRunner` emits (`15-cost-tracking-system.md`)
- **Outputs:** `metrics.costEvents[]` (append), `metrics.totalCostUsd` (recomputed), `errors[]` (append), `timings[]` (append)
- **Dependencies:** `logging/logger.ts`, `lib/dates.ts` — **Prompt file:** n/a — **LLM used:** none — **Retry policy:** none
- **Estimated token usage / cost:** 0 / $0

### Cost Reporter *(new in this revision — formalizes `15-cost-tracking-system.md`)*
- **Purpose:** Consume `metrics.costEvents[]` (one run) or the cross-run `storage/costs/*.jsonl` log (a date range) and produce the per-module cost breakdown report — the exact table format specified in `15-cost-tracking-system.md`. Previously this existed only as an implicit "the Notification attaches a cost summary" behavior; formalizing it as its own reporting step means the same report can be requested standalone (a CLI command, or a future dashboard query) without running Notification at all.
- **Inputs:** `metrics.costEvents[]`, or an externally-supplied `CostEvent[]` range from `storage/costs/`
- **Outputs:** a `CostReport` object attached to the run summary handed to Notification; **writes nothing back into `PipelineState`** — this is a pure read-side view, consistent with `17-module-dependency-diagram.md`'s note that the Cost Reporter is not part of the write path
- **Dependencies:** `src/reporting/costReporter.ts` — no provider, no Sanity, no Sheets dependency, by design (`15-cost-tracking-system.md`'s "works regardless of provider" requirement)
- **Prompt file:** n/a — **LLM used:** none — **Retry policy:** none (pure function over already-collected data — nothing to retry)
- **Validation:** report totals reconcile exactly against the sum of input `CostEvent[]` — a pure-function correctness check, not a schema validation
- **Estimated token usage / cost:** 0 / $0

---

## Content pipeline modules

### Sheet Reader *(registry key: `sheet-reader`)*
- **Purpose:** Read the next pending topic-brief row from Google Sheets, mark it "in progress," normalize it into the seed shape the pipeline expects.
- **Inputs:** none from `PipelineState` (this module creates the initial state) — reads from the Sheets integration
- **Outputs:** `state.brief` (topic, target audience, keyword hints, constraints, sheet row ID), `state.metadata.sheetRowId`
- **Dependencies:** `integrations/sheets/SheetsClient.ts`
- **Prompt file:** none — **LLM used:** none
- **Retry policy:** 3 attempts, exponential backoff, retryable on network/rate-limit errors from the Sheets API only
- **Validation:** required columns present; row not already marked "done"/"in progress"
- **Estimated token usage / cost:** 0 / $0

### Research *(registry key: `research`)*
- **Purpose:** Gather factual grounding — key facts, statistics, competing angles, required source material.
- **Inputs:** `state.brief`
- **Outputs:** `state.research` (`keyFacts[]`, `suggestedAngle`, `competitorGapNotes?`, `candidateStatistics[]`)
- **Dependencies:** `providers/llm`, optionally a web-search-capable tool
- **Prompt file:** `prompts/research/system.md`, `prompts/research/user.md`, `prompts/research/examples.md`
- **LLM used:** `STANDARD` — **Retry policy:** 2 attempts, retry on transient provider errors and schema-validation failure (re-prompt with the failure appended)
- **Validation:** matches `ResearchSection` schema; ≥3 key facts
- **Estimated token usage:** ~1,200 in / ~900 out — **Estimated cost:** ≈ **$0.016/run**

### Content Planner *(registry key: `planner`)*
- **Purpose:** Turn brief + research into a concrete outline — title candidates, H2/H3 structure, per-section talking points, target word count, angle.
- **Inputs:** `state.brief`, `state.research`
- **Outputs:** `state.planning` (`titleCandidates[]`, `outline[]`, `targetWordCount`, `angle`)
- **Dependencies:** `providers/llm`
- **Prompt file:** `prompts/planner/system.md`, `prompts/planner/user.md`, `prompts/planner/examples.md`
- **LLM used:** `PREMIUM` — outline quality drives everything downstream
- **Retry policy:** 2 attempts, retry on schema-validation failure
- **Validation:** ≥3 top-level sections; each with ≥1 talking point; word count in [800, 3000]
- **Estimated token usage:** ~1,800 in / ~700 out — **Estimated cost:** ≈ **$0.027/run**

### SEO Planner *(registry key: `seo-planner`)*
- **Purpose:** Decide focus keyword, supporting `seoKeywords`, target `seoTitle`/`metaDescription` shape, and internal-link targets, before the article is written.
- **Inputs:** `state.brief`, `state.research`, `state.planning`
- **Outputs:** `state.seo` (`focusKeyword`, `seoKeywords[]`, `seoTitleDraft`, `metaDescriptionDraft`, `internalLinkTargets[]`)
- **Dependencies:** `providers/llm`, `integrations/sanity/sanityReadClient.ts` (existing-posts list, cached per `06-cost-optimization.md` / `14-core-utilities.md`'s `lib/cache.ts`)
- **Prompt file:** `prompts/seo-planner/{system,user,examples}.md`
- **LLM used:** `STANDARD` — **Retry policy:** 2 attempts, retry on schema-validation failure
- **Validation:** `focusKeyword` non-empty; `seoKeywords.length` ≤ 15 and unique
- **Estimated token usage:** ~1,000 in / ~400 out — **Estimated cost:** ≈ **$0.008/run**

### Article Writer *(registry key: `writer`)*
- **Purpose:** Write the full article body from outline, research, and SEO plan — an internal Markdown-with-metadata representation, never Portable Text directly, with `[[link: target]]` and `[[image: description]]` markers.
- **Inputs:** `state.planning`, `state.seo`, `state.research`
- **Outputs:** `state.draft.current` (writes the initial version; nothing yet in `state.draft.history` since this is the first writer)
- **Dependencies:** `providers/llm`
- **Prompt file:** `prompts/writer/{system,user,validation,examples}.md`
- **LLM used:** `PREMIUM` — the single most quality-sensitive step in the pipeline
- **Retry policy:** 2 attempts, retry on schema-validation failure
- **Validation:** word count within ±20% of `planning.targetWordCount`; every planned H2 present as a heading; markers well-formed
- **Estimated token usage:** ~2,500 in / ~2,800 out — **Estimated cost:** ≈ **$0.083/run**

### Technical Reviewer *(registry key: `reviewer-technical`)*
- **Purpose:** Check the draft for factual consistency with research, logical structure, unsupported claims, domain-terminology accuracy. Produces an issue list, not a rewrite.
- **Inputs:** `state.draft.current`, `state.research`
- **Outputs:** `state.review.technical` (`issues[]`, `passed`)
- **Dependencies:** `providers/llm`
- **Prompt file:** `prompts/reviewer-technical/{system,user,validation}.md`
- **LLM used:** `STANDARD` — **Retry policy:** 2 attempts on schema-validation failure only (a "found issues" result is a valid success, not a retry trigger)
- **Validation:** matches `ReviewOutput` schema; every issue has severity in `{low, medium, high}`
- **Estimated token usage:** ~3,200 in / ~500 out — **Estimated cost:** ≈ **$0.014/run**

### SEO Reviewer *(registry key: `reviewer-seo`)*
- **Purpose:** Check the draft against `state.seo` — keyword placement/density, heading structure, whether `seoTitleDraft`/`metaDescriptionDraft` still fit the final content.
- **Inputs:** `state.draft.current`, `state.seo`
- **Outputs:** `state.review.seo` (`issues[]`, `passed`, `revisedSeoTitle?`, `revisedMetaDescription?`)
- **Dependencies:** `providers/llm`
- **Prompt file:** `prompts/reviewer-seo/{system,user,validation}.md`
- **LLM used:** `CHEAP` — mechanical, checklist-style review
- **Retry policy:** 2 attempts on schema-validation failure only
- **Validation:** matches `ReviewOutput` schema
- **Estimated token usage:** ~2,800 in / ~350 out — **Estimated cost:** ≈ **$0.005/run**

### Humanizer *(registry key: `humanizer`)*
- **Purpose:** Rewrite for voice — remove AI-generated tells — without changing facts, structure, or locked-in SEO elements.
- **Inputs:** `state.draft.current`, `state.review.technical`, `state.review.seo`
- **Outputs:** `state.draft.current` (new version; the prior `current` is appended to `state.draft.history` with `producedBy: 'humanizer'` — per `04-json-contracts.md`'s draft-history redesign, this is no longer a silent overwrite)
- **Dependencies:** `providers/llm`
- **Prompt file:** `prompts/humanizer/{system,user}.md`
- **LLM used:** `STANDARD` — **Retry policy:** 2 attempts, retry on schema-validation failure
- **Validation:** word count within ±15% of input draft's word count; all H2s from `planning` still present
- **Estimated token usage:** ~2,900 in / ~2,900 out — **Estimated cost:** ≈ **$0.078/run**

### QA Gate *(registry key: `qa`)*
- **Purpose:** The bounded-loop gatekeeper. Re-checks the current draft against both review sections and decides `pass` / `needsRevision` / `failClosed`.
- **Inputs:** `state.draft.current`, `state.review.technical`, `state.review.seo`, `state.review.loop.iteration`
- **Outputs:** `state.qa` (`decision`, `remainingIssues[]`)
- **Dependencies:** `providers/llm` (a small classification call)
- **Prompt file:** `prompts/qa/{system,user,validation}.md`
- **LLM used:** `CHEAP` — **Retry policy:** 2 attempts on schema-validation failure only
- **Validation:** `decision` is a valid enum value; `state.review.loop.iteration` never exceeds `config.pipeline.maxReviewIterations` (default 3) — enforced in code
- **Estimated token usage:** ~1,200 in / ~150 out — **Estimated cost:** ≈ **$0.002/run** (paid once per loop iteration)

### Article Improver *(registry key: `improver`)*
- **Purpose:** Apply `qa.remainingIssues` as targeted edits — a repair pass, not a rewrite. Only invoked on `needsRevision`.
- **Inputs:** `state.draft.current`, `state.qa.remainingIssues`
- **Outputs:** `state.draft.current` (new version; prior appended to `state.draft.history` with `producedBy: 'improver'`)
- **Dependencies:** `providers/llm`
- **Prompt file:** `prompts/improver/{system,user,repair}.md`
- **LLM used:** `PREMIUM` — rare path (loop-only), so aggregate cost stays low despite premium tier
- **Retry policy:** 2 attempts, retry on schema-validation failure
- **Validation:** every issue in `remainingIssues` marked addressed-or-rejected-with-reason; word count still within ±20% of original target
- **Estimated token usage:** ~3,200 in / ~2,600 out — **Estimated cost:** ≈ **$0.081/run** (only on runs needing revision)

> **Review loop wiring** (orchestrator-enforced): `reviewer-technical → reviewer-seo → humanizer → qa`. If `pass`, exit. If `needsRevision`, run `improver`, the orchestrator increments `state.review.loop.iteration`, and re-enters at `reviewer-technical`. If `failClosed`, the orchestrator sets `state.metadata.status = 'needs_review'` and routes to `notify` — never proceeding to Media/Structure/Publish with unresolved high-severity issues.

### Image Planner *(registry key: `image-planner`)*
- **Purpose:** Turn `state.draft.current`'s image markers (plus the hero-image need) into concrete image-generation briefs — subject, composition, aspect ratio (1200×630 for OG), alt-text draft.
- **Inputs:** `state.draft.current`, `state.planning`
- **Outputs:** `state.images.plan` (`images[]`)
- **Dependencies:** `providers/llm`
- **Prompt file:** `prompts/image-planner/{system,user}.md`
- **LLM used:** `CHEAP` — **Retry policy:** 2 attempts on schema-validation failure
- **Validation:** exactly one `role: 'hero'` entry; every entry has non-empty `altTextDraft`
- **Estimated token usage:** ~1,500 in / ~500 out — **Estimated cost:** ≈ **$0.004/run**

### Image Generator *(registry key: `image-generator`)*
- **Purpose:** Call the configured image provider for each planned image, in parallel (`17-module-dependency-diagram.md`).
- **Inputs:** `state.images.plan`
- **Outputs:** `state.images.generated` (each retry replaces that one image's entry by `imageId` — no history array, per `04-json-contracts.md`'s revised design; a failed regeneration is a replacement, not a reviewable revision)
- **Dependencies:** `providers/image/ImageProvider.ts`
- **Prompt file:** none — prompts come from `state.images.plan`, produced by Image Planner's own prompt
- **LLM used:** image-gen model per `providers/image/imageProviderFactory.ts`
- **Retry policy:** 3 attempts per image, independent per image, exponential backoff on rate-limit/5xx
- **Validation:** returned image byte size > 0, accepted content-type (`lib/imageHelpers.ts`, `14-core-utilities.md`)
- **Estimated cost:** provider-dependent, budget $0.02–$0.08/image, typically 2–4 images/run ⇒ ≈ **$0.04–$0.32/run**

### Image Validator *(registry key: `image-validator`)*
- **Purpose:** Confirm each generated image matches its brief via a vision-capable call; reject and trigger regeneration for failures, bounded by a max-retry loop.
- **Inputs:** `state.images.generated`, `state.images.plan`
- **Outputs:** `state.images.validation` (`[]`: `{ imageId, passed, reason?, retriesUsed }`)
- **Dependencies:** `providers/llm` (vision-capable — `LLMProvider.supportsVision`, `09-provider-abstraction.md`)
- **Prompt file:** `prompts/image-validator/{system,user,validation}.md`
- **LLM used:** `STANDARD` (vision-capable)
- **Retry policy:** on failure, re-invoke Image Generator for that image only, up to `config.pipeline.maxImageRetries` (default 2), then fail closed for that slot and fall back to no inline image rather than blocking the run (the hero image failing is treated differently — see `07-error-handling.md`'s image-loop partial-failure policy, unchanged)
- **Validation:** schema-valid boolean-per-image output
- **Estimated token usage:** ~800 in / ~150 out per image — **Estimated cost:** ≈ **$0.004/image**, ≈ **$0.008–$0.016/run** for 2–4 images

### Image Upload *(registry key: `image-upload`)*
- **Purpose:** Upload every validated image to Sanity's asset store, obtaining real `asset._id` values before any Portable Text referencing those images is built.
- **Inputs:** `state.images.generated`, `state.images.validation`
- **Outputs:** `state.images.uploaded` (`[]`: `{ imageId, role, assetId, altText, placementMarkerId? }`)
- **Dependencies:** `integrations/sanity/sanityWriteClient.ts`
- **Prompt file:** none — **LLM used:** none
- **Retry policy:** 3 attempts, exponential backoff, retryable on Sanity API transient errors
- **Validation:** asset IDs match Sanity's `image-<hash>-<dims>-<ext>` shape; only validated images uploaded
- **Estimated cost:** $0 (Sanity storage cost outside this pipeline's LLM/image-gen model)

### Internal Link Generator *(registry key: `internal-links`)*
- **Purpose:** Resolve `state.seo.internalLinkTargets` (plus any additional draft link opportunities) into real, live Sanity post `_id`s, producing the marker→reference mapping the Portable Text Converter needs.
- **Inputs:** `state.seo.internalLinkTargets`, `state.draft.current`
- **Outputs:** `state.sanity.resolvedLinks` (`[]`: `{ markerId, targetPostId, targetSlug, anchorText }`)
- **Dependencies:** `integrations/sanity/sanityReadClient.ts`; `providers/llm` only for the anchor-text-selection sub-case
- **Prompt file:** `prompts/internal-links/{system,user}.md` (used only for that sub-case)
- **LLM used:** `CHEAP` — **Retry policy:** 2 attempts on Sanity read errors; a target that no longer resolves is dropped and logged, never blocks the run
- **Validation:** every `targetPostId` corresponds to a real, currently-published post (re-checked at write time)
- **Estimated cost:** ≈ **$0.001/run** (frequently $0 when the LLM path isn't needed)

### Portable Text Converter *(registry key: `portable-text`)*
- **Purpose:** Deterministically convert the final Markdown draft (with resolved links and image placements) into the exact Portable Text JSON shape Blogspage Agency's schema requires.
- **Inputs:** `state.draft.current`, `state.sanity.resolvedLinks`, `state.images.uploaded`
- **Outputs:** `state.sanity.portableText`
- **Dependencies:** `lib/portableText/fromMarkdownAst.ts`, `lib/portableText/validatePortableText.ts`, `lib/markdown.ts` (`14-core-utilities.md`) — **no LLM call**
- **Prompt file:** none — **LLM used:** none
- **Retry policy:** none needed for the transform (deterministic); malformed input Markdown is a `ValidationError`, not a retryable condition
- **Validation:** every invariant in `knowledge/automation-integration.md`'s "Required validations before writing" list
- **Estimated cost:** $0

> **Execution-order note (unchanged from the original pass, restated with new state paths):** Internal Link Generator must resolve real post `_id`s into `state.sanity.resolvedLinks` *before* Portable Text Converter runs, since `internalLink` markDefs need a real reference. The orchestrator sequences these accordingly — see `17-module-dependency-diagram.md`'s dependency graph, which is now the authoritative source for execution order, superseding the plain-text ordering note this document previously carried.

### FAQ Generator *(registry key: `faq-generator`)*
- **Purpose:** Produce 3–6 FAQ items grounded in the article content, sized to schema constraints (`question` ≤160 chars, `answer` ≥20 chars) — feeds the site's render-time `FAQPage` JSON-LD for free.
- **Inputs:** `state.draft.current`, `state.seo.focusKeyword`
- **Outputs:** `state.sanity.faq` (`[]`: `{ question, answer }`)
- **Dependencies:** `providers/llm`
- **Prompt file:** `prompts/faq-generator/{system,user}.md`
- **LLM used:** `CHEAP` — **Retry policy:** 2 attempts on schema-validation failure
- **Validation:** 3–6 items; every question ≤160 chars; every answer ≥20 chars; questions unique
- **Estimated token usage:** ~1,800 in / ~400 out — **Estimated cost:** ≈ **$0.004/run**

### Structured-Data Readiness Validator *(registry key: `structured-data-check`)*
*(the requested "JSON-LD Generator," reconciled per `01-system-overview.md` — Blogspage Agency builds JSON-LD at render time, so this module validates inputs to that process rather than authoring JSON-LD directly)*
- **Purpose:** Confirm every field the site's `BlogPosting`/`BreadcrumbList`/`FAQPage` JSON-LD builders read is populated and within spec before the document is written.
- **Inputs:** `state.seo`, `state.draft.current`, `state.images.uploaded`, `state.sanity.faq`, `state.metadata`
- **Outputs:** `state.sanity.structuredDataCheck` (`{ ready, missing[], autoFilled[] }`)
- **Dependencies:** none — pure validation, **no LLM call**
- **Prompt file:** none — **LLM used:** none — **Retry policy:** none (deterministic check)
- **Validation:** itself *is* a validation step; a hard-required field genuinely missing (excerpt, mainImage if planned) fails closed; a soft-missing field auto-fills with a safe fallback
- **Estimated cost:** $0

### Sanity Document Builder *(registry key: `sanity-builder`; renamed from the original `19-sanity-upload`, see revision note above)*
- **Purpose:** Assemble the final Sanity `post` document JSON from every prior module's output — title, slug (uniqueness-checked against `sanityReadClient.ts`, via `lib/slug.ts`), excerpt, references, `mainImage`, `content`, all SEO fields, `faq`. The deterministic "final zip" step. Performs no network upload itself — that's Publish's job (the reason for the rename).
- **Inputs:** the full accumulated `PipelineState` (documented convergence read — `17-module-dependency-diagram.md`)
- **Outputs:** `state.sanity.document`
- **Dependencies:** `lib/slug.ts`, `integrations/sanity/sanityReadClient.ts`, `integrations/sanity/seedRefs.ts` — **no LLM call**
- **Prompt file:** none — **LLM used:** none
- **Retry policy:** slug-uniqueness check retried up to 3 times with a numeric-suffix strategy — a normal resolution path, not an error condition
- **Validation:** every rule in `knowledge/automation-integration.md`'s "Required fields" and "Required validations before writing" re-checked one final time
- **Estimated cost:** $0

### Publish *(registry key: `publish`)*
- **Purpose:** Write the assembled document to Sanity (`client.create()`, or `transaction()` if also patching a sheet-status field), then mark the run's sheet row `done`.
- **Inputs:** `state.sanity.document`
- **Outputs:** `state.publishing` (`{ documentId, publishedAt, sheetRowUpdated, liveUrlEstimate }`); on success, the orchestrator sets `state.metadata.status = 'published'`
- **Dependencies:** `integrations/sanity/sanityWriteClient.ts`, `integrations/sheets/SheetsClient.ts`
- **Prompt file:** none — **LLM used:** none
- **Retry policy:** 3 attempts, exponential backoff, retryable on Sanity transient errors only — **never retry blindly on ambiguous-outcome errors** (re-check by slug before retrying, per `07-error-handling.md`'s idempotency rule, unchanged)
- **Validation:** Sanity response contains a valid `_id`; a follow-up read confirms the document is fetchable
- **Estimated cost:** $0

### Notification *(registry key: `notify`)*
- **Purpose:** Send a Slack/email summary of the run outcome — published (with live URL), needs-review (with blocking issues), or failed (with the error) — plus the Cost Reporter's summary and the run's `errors[]`/`timings[]` sections.
- **Inputs:** the final `PipelineState`, the `CostReport` from Cost Reporter
- **Outputs:** none added to `PipelineState` (terminal module; emits externally)
- **Dependencies:** `integrations/notify/SlackNotifier.ts`, `integrations/notify/EmailNotifier.ts`
- **Prompt file:** none — **LLM used:** none
- **Retry policy:** 2 attempts on delivery failure; a failed notification never re-triggers the pipeline or blocks marking the run complete
- **Validation:** none beyond delivery-API success response
- **Estimated cost:** $0

---

## Orchestrator execution order

Superseded by the Mermaid dependency graph and parallelization tables in `17-module-dependency-diagram.md`, which is now the single authoritative source for execution order (including the parallel-reviewer and parallel-image groupings this document's original plain-text diagram only partially captured). This document's per-module "Dependencies" fields remain the authoritative source for *what each module needs*; `17-module-dependency-diagram.md` is authoritative for *the order that satisfies those needs*.

Total per-run LLM-bearing module cost (typical run, no loop retries): approximately **$0.31–$0.60**, unchanged from the original estimate — see `06-cost-optimization.md` and `15-cost-tracking-system.md`'s worked example ($0.401/run baseline, $0.485/run with one review-loop iteration) for the full breakdown.
