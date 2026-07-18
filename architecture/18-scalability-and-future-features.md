# 18 — Future Scalability

## How to read this document

For each future direction, the format is: **what would break today**, then **what already absorbs it without a rewrite**, then **what minimal addition is actually needed**. The goal is not to build any of this now — it's to prove, in writing, that today's architecture doesn't foreclose it, and to name the exact seam each feature would attach to. Anything that *would* require a rewrite is called out explicitly as a real limitation, not glossed over.

## Multiple websites / multiple brands / multiple CMS platforms

**What would break today:** `integrations/sanity/sanityWriteClient.ts` hardcodes one `projectId`/`dataset` pair, and the entire Publish/Sanity Document Builder pair assumes Sanity specifically.

**What already absorbs it:** Nothing in `04-json-contracts.md`'s content-producing sections (`research`, `planning`, `seo`, `draft`, `review`, `qa`, `images`) mentions Sanity at all — those sections are CMS-agnostic by construction, because they were designed around *content*, not around the target system's schema. The Sanity-specific shape only appears at the very last stage (`sanity.document`, built by Sanity Document Builder immediately before Publish). This is not an accident — `09-provider-abstraction.md`'s "swap without touching business logic" principle was applied to LLM providers first, but the same shape (an interface at the boundary, a concrete adapter behind it) generalizes to *any* external system this pipeline writes to.

**What's actually needed:** A `PublishTarget` interface, symmetric to `LLMProvider`:

```ts
interface PublishTarget {
  buildDocument(state: PipelineState): Promise<unknown>;   // CMS-specific shape, opaque to the caller
  publish(document: unknown): Promise<{ id: string; url: string }>;
  checkSlugAvailable(slug: string): Promise<boolean>;
}
```

`SanityPublishTarget` becomes the first (and, for a long time, only) implementation. Modules 19–20 (`03-module-flow.md`) become "call `publishTarget.buildDocument(state)`" and "call `publishTarget.publish(doc)`" instead of directly importing `sanityWriteClient` — the exact same refactor `09-provider-abstraction.md` already did for LLM calls, applied one layer later. `state.metadata` gains a `targetSite: string` field (already present in the revised schema — see the `04-json-contracts.md` update — specifically to make this addition non-breaking when it happens) so a run's config can select which `PublishTarget` to resolve, the same way `models.ts` selects an `LLMProvider` per tier. **This is a real, scoped piece of future work, not free** — it's called out honestly as "not built yet," but the shape it will take is already implied by an abstraction this architecture already committed to elsewhere, which is the actual claim being made: not "zero work," but "no rewrite, because the pattern already exists and just needs to be applied one more time."

## Multiple languages

Already fully designed in `13-prompt-management-system.md`'s "Future localization support" section — the prompt inheritance/override resolution chain treats locale as one more axis alongside tenant, and `state.metadata.locale` (defaulted `'en'` today) threads through without any module signature changing. Not repeated in full here; that document is the authoritative source. The one addition beyond prompts: `SanityPostDocument`/`PublishTarget.buildDocument` would need to know which locale's document shape to build (if the CMS models translations as separate documents, e.g. Sanity's own internationalization patterns), which is a `PublishTarget`-implementation concern, not a pipeline-module concern — modules produce locale-tagged content; the publish target decides how that locale is represented in the destination CMS.

## Multi-tenant SaaS / multiple brands with different writing styles

**What would break today:** Nothing structural — this is the more interesting case, because it's mostly a *configuration* scaling question rather than an *architecture* one, given the two seams already in place:

- **Voice/style per brand** → `13-prompt-management-system.md`'s tenant-override resolution chain (`src/prompts/overrides/{tenantId}/...`) is exactly the mechanism — a new brand with a different voice is a new `shared/brand-voice.md` override, not new code.
- **Different target sites per brand** → the `PublishTarget`/`targetSite` mechanism above.
- **Different model-tier budgets per brand** (a SaaS customer on a cheaper plan should resolve to cheaper tiers) → `src/config/models.ts`'s tier-to-provider mapping already separates "which tier a module uses" (fixed, per `06-cost-optimization.md`'s tiering table) from "which provider/model a tier resolves to" (config). Making that resolution *also* a function of `tenantId` is a small, additive change to `providerFactory.getProvider(tier, config, tenantId?)` — the function signature grows an optional parameter, it does not change shape.

**What's actually needed beyond config:** `runId`-scoping already exists (`04-json-contracts.md`); a `tenantId` field needs to be threaded alongside it into `PipelineState.metadata`, `CostEvent` (`15-cost-tracking-system.md` already names this as the exact, anticipated addition), and `stateStore`'s persistence key. This is real work — a schema field added in three or four places — but it is additive, not a redesign of any of those three systems. **The one honest gap:** true SaaS multi-tenancy also implies tenant data isolation (one tenant's `PipelineState` must never be readable by another tenant's process), which `core/stateStore.ts`'s v1 local-JSON-file design does not provide — this is explicitly named in `12-future-roadmap.md`'s deferred list ("swapping `stateStore` from local JSON to a real database") as the trigger point where isolation becomes a real requirement, not before.

## Team collaboration / human approval workflows

**What already absorbs it:** The `needs_review` status (`04-json-contracts.md`'s `metadata.status` enum) and the fail-closed review-loop design (`07-error-handling.md`) already model "a human needs to look at this before it goes further" as a first-class pipeline outcome, not an afterthought. Notification (module 21) already fires with the specific blocking issues attached.

**What's actually needed:** A resume path — today, `needs_review` is terminal (a human fixes something outside the pipeline, and a *new* run is triggered). Real approval workflows need `stateStore`'s existing resume-from-last-checkpoint capability (`11-performance.md` already documents this for crash recovery) extended to support **resuming with a human-supplied override** (e.g. a human manually approves a specific draft despite QA's objection, or edits `state.draft` directly before resuming). This is a natural extension of a capability that already exists for a different reason (crash resumability), not a new capability — the gap is a small "resume with patch" API on `stateStore`, not new infrastructure.

## Scheduled publishing / content calendars

**What already absorbs it:** `lib/dates.ts` (`14-core-utilities.md`) already centralizes date handling specifically so a future scheduling feature doesn't inherit inconsistent date logic. Sheet Reader already reads a queue of pending rows one at a time — a content calendar is, structurally, a richer version of "the queue Sheet Reader reads from," and Sheet Reader's own output (`state.brief`) doesn't need to change shape to support it.

**What's actually needed:** `SanityPostDocument.publishedAt` today is set at write time; scheduled publishing needs Publish (module 20) to optionally write the document with a future `publishedAt` and *not* immediately mark it live-visible (a Sanity-side concern — draft vs. published document state, which Sanity already supports natively) — this is a `PublishTarget`-level capability addition (a `scheduleFor?: string` parameter on `publish()`), not a pipeline-shape change.

## A/B testing (of prompts, headlines, or images)

**What already absorbs it:** `13-prompt-management-system.md`'s deferred "prompt variants" note already names this exact feature and its trigger condition (enough run volume for statistically meaningful signal). The registry's resolution-chain design (tenant → locale → base) generalizes to a fourth axis (`variantId`) using the identical mechanism, and `CostEvent.promptVersion` already gives A/B analysis a way to attribute cost/outcome to a specific prompt version without new tracking infrastructure.

## Social media generation / newsletter generation / video script generation / podcast generation

**What already absorbs it:** These are all, structurally, "a different `PipelineState` shape produced by a different subset of modules, published through a different `PublishTarget`." The module list in `03-module-flow.md` was already designed (per `01-system-overview.md`'s "Reusable" goal) as small, single-purpose, composable units — Research, Content Planner, and SEO Planner have no blog-specific assumption baked in; a newsletter or a social post needs the same "gather facts → plan structure → write → review" shape, just a different Article Writer prompt (shorter output, different `system.md`) and a different final-assembly module in place of Sanity Document Builder.

**What's actually needed, honestly:** This is the largest genuine future undertaking on this list, and it should not be understated as "just swap the writer prompt." A podcast script or a video script has real, non-trivial structural differences from a blog post (timing/pacing constraints, speaker turns, visual cues) that would need their own Content Planner variant and their own review criteria — new prompt sets and likely one or two new specialized modules, not zero new work. What *is* true, and worth stating precisely: none of that new work requires touching the *provider abstraction*, the *prompt registry*, the *cost tracking system*, the *retry/error handling*, or the *orchestrator's* core loop mechanics — it is new *content* (prompts, schemas for the new output shape) built on unchanged *infrastructure*. That is the actual, defensible scalability claim this architecture makes, and it's narrower than "supports everything without any new code," which would be an overclaim.

## The one structural principle underneath all of the above

Every "future feature" analysis above resolves to the same pattern: **an interface already exists at the right boundary, or a config field already exists at the right layer, because this architecture consistently pushes variability to the edges (providers, publish targets, prompts, config) and keeps the middle (module logic, orchestration, error handling, cost tracking) fixed.** Where that pattern doesn't yet hold — tenant data isolation in `stateStore`, and genuinely new content types needing genuinely new modules — this document says so plainly rather than stretching the pattern to cover it. That honesty is itself the argument for why the pattern can be trusted where it does hold.
