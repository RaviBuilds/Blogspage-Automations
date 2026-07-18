# 04 — JSON Contracts (revised)

> **Revision note:** This document replaces the flat `PipelineState` design from the original architecture pass. The original design (one top-level key per module, e.g. `state.contentPlan`, `state.seoPlan`, `state.imageValidation`) was correct in spirit — zero-transformation handoff, one writer per key — but it did not scale its *organization*. At 21 modules, a flat namespace of 20+ top-level keys makes "which section does this belong to" a fact you have to memorize rather than read off the structure. The revision below groups those same keys into named sections (`metadata`, `research`, `planning`, `seo`, `draft`, `review`, `qa`, `images`, `sanity`, `publishing`, `metrics`, `errors`, `timings`), per the refinement request's explicit taxonomy. **The zero-transformation, one-writer-per-field principle is unchanged** — only the namespacing changed. See "Migration from the flat design" at the end of this document for the old-key → new-path mapping.

## Design goals for this revision

1. **A module should only ever need to touch one named section.** Not one top-level key among twenty — one *section*, matching the mental model a developer builds once and reuses for every module they touch (this is also what makes `13-prompt-management-system.md`'s and `15-cost-tracking-system.md`'s shared `moduleKey` vocabulary line up cleanly with a shared `PipelineState` vocabulary — one taxonomy, not three).
2. **Every writer of every field is named, and multi-writer fields are the rare, explicit exception, not the default.** The original document had exactly two documented exceptions (Humanizer/Improver overwriting `draft`). This revision reduces that to **zero silent overwrites** — see "The draft-history redesign" below, which resolves the one place the old design still had a module clobbering another module's prior output.
3. **Sections that need audit history (cost, errors, timing) are append-only arrays, never mutated in place.** This wasn't a concern in the original design (it had no cost-tracking or structured-error-history concept yet); it's a hard requirement now that `15-cost-tracking-system.md` exists.

## The revised `PipelineState`

```ts
interface PipelineState {
  metadata: Metadata;
  brief?: Brief;                    // Sheet Reader's output — see naming note below
  research?: ResearchSection;
  planning?: PlanningSection;
  seo?: SeoSection;
  draft?: DraftSection;
  review?: ReviewSection;
  qa?: QaSection;
  images?: ImagesSection;
  sanity?: SanitySection;
  publishing?: PublishingSection;
  metrics: MetricsSection;          // always present, starts empty — append-only from run start
  errors: ErrorRecord[];             // always present, starts empty — append-only from run start
  timings: TimingRecord[];           // always present, starts empty — append-only from run start
}
```

**Naming note on `brief`:** the refinement request's example taxonomy didn't list a `brief` section, but Sheet Reader (module 1) has to own *something* — the raw topic input every other section is downstream of. Adding it is a minor, necessary extension of the requested taxonomy, not a deviation from it; it's called out explicitly here so it's clear this was a considered addition, not an oversight.

**Naming note on `sanity`:** kept as-is for v1, matching the refinement request's own example. Flagged here as a deliberate, temporary naming choice: `18-scalability-and-future-features.md`'s `PublishTarget` abstraction means this section's *content* (Portable Text, resolved links, the assembled document) is not actually Sanity-specific in shape until the very last field (`sanity.document`, which is genuinely CMS-shaped). When a second `PublishTarget` implementation is ever built, this section should rename to something CMS-neutral (e.g. `structuredContent`) — documented as a known, low-cost future rename rather than something to solve speculatively now, since renaming one section key is a mechanical, low-risk change whenever it happens.

---

## `Metadata`

```ts
interface Metadata {
  runId: string;                    // uuid, generated at run start
  startedAt: string;                // ISO 8601, from lib/dates.ts
  sheetRowId: string;
  status: 'running' | 'published' | 'needs_review' | 'failed';
  tenantId?: string;                 // absent in v1 (single-tenant); reserved per 18-scalability-and-future-features.md
  locale: string;                    // defaults 'en'; reserved per 13-prompt-management-system.md's localization design
  targetSite: string;                // defaults 'blogspage'; reserved per 18-scalability-and-future-features.md's PublishTarget design
}
```

**Owner:** the orchestrator initializes this section at run start (`runId`, `startedAt`, `locale`, `targetSite`, `status: 'running'`). Sheet Reader sets `sheetRowId`. The orchestrator (never a module directly) transitions `status` at well-defined points: `running` → `published` (after Publish succeeds), `running` → `needs_review` (review-loop `failClosed`, or a hard-required field missing at the Structured-Data check), `running` → `failed` (an unretryable `FatalError` anywhere else). **This is the one section with a field — `status` — that is written more than once over a run's lifetime, and it is written exclusively by the orchestrator, never by a module.** That's the whole rule for this section: modules read `metadata`, only the orchestrator writes `metadata.status`.

## `Brief` (Sheet Reader — module 1, registry key `sheet-reader`)

```ts
interface Brief {
  topic: string;
  targetAudience?: string;
  keywordHints?: string[];
  constraints?: string[];
  sheetRowId: string;
}
```
Write-once. No other module writes to `state.brief`.

## `ResearchSection` (Research — module 2, registry key `research`)

```ts
interface ResearchSection {
  keyFacts: string[];
  suggestedAngle: string;
  competitorGapNotes?: string[];
  candidateStatistics: { claim: string; informalSource?: string }[];
}
```
Write-once.

## `PlanningSection` (Content Planner — module 3, registry key `planner`)

```ts
interface PlanningSection {
  titleCandidates: string[];
  outline: { heading: string; level: 2 | 3; talkingPoints: string[] }[];
  targetWordCount: number;
  angle: string;
}
```
Write-once.

## `SeoSection` (SEO Planner — module 4, registry key `seo-planner`)

```ts
interface SeoSection {
  focusKeyword: string;
  seoKeywords: string[];
  seoTitleDraft: string;
  metaDescriptionDraft: string;
  internalLinkTargets: { candidateSlug: string; candidateTitle: string; relevance: 'high' | 'medium' }[];
}
```
Write-once. **Note the change from the original design:** SEO Reviewer's `revisedSeoTitle`/`revisedMetaDescription` no longer live here — they moved to `review.seo` (below), specifically so this section keeps exactly one writer. Sanity Document Builder reads a fallback chain (`review.seo.revisedSeoTitle ?? seo.seoTitleDraft`) rather than SEO Planner's own output being mutated by a later module. This is the first of two "used to be a multi-writer field, now isn't" fixes in this revision.

## `DraftSection` (Article Writer — module 5, registry key `writer`; Humanizer — module 8, registry key `humanizer`; Article Improver — module 10, registry key `improver`)

```ts
interface DraftSection {
  current: Draft;
  history: { producedBy: string; at: string; draft: Draft }[];
}

interface Draft {
  markdown: string;
  wordCount: number;
  linkMarkers: { markerId: string; anchorTextHint: string }[];
  imageMarkers: { markerId: string; role: 'hero' | 'inline'; descriptionHint: string }[];
}
```

### The draft-history redesign (the second, and last, multi-writer fix)

The original design had `state.draft` **overwritten** by Humanizer and again by Article Improver, documented as an accepted exception because "humanizing is a rewrite of the same artifact." That reasoning was sound, but the mechanism — silent overwrite — loses the prior version with no trace, which is a real gap at commercial scale: if a published article's voice looks wrong, there was no way to inspect what the pre-humanize draft looked like, or which specific module changed what.

This revision keeps the same *rule* (only Writer/Humanizer/Improver may touch this section; nothing else does) but changes the *mechanism*: `draft.current` is the live pointer every downstream module reads, and every write to `current` first appends the *previous* `current` value to `draft.history` with `producedBy` set to the writing module's registry key and `at` set to a timestamp. Reading `draft.current` always gets the latest version, exactly as before — nothing downstream of Draft needs to change how it reads this section. What's gained: a full, ordered, attributable version history of every draft revision in a run, for free, which directly serves the "commercial platform" framing of this refinement request (traceability, debuggability, the ability to answer "what did Humanizer actually change" after the fact) without changing any consumer's read path.

## `ReviewSection` (Technical Reviewer — module 6, registry key `reviewer-technical`; SEO Reviewer — module 7, registry key `reviewer-seo`; orchestrator owns `loop`)

```ts
interface ReviewSection {
  technical?: ReviewOutput;
  seo?: ReviewOutput;
  loop: { iteration: number };       // orchestrator-owned counter, never written by a module
}

interface ReviewOutput {
  passed: boolean;
  issues: { id: string; severity: 'low' | 'medium' | 'high'; location: string; description: string; suggestedFix?: string }[];
  revisedSeoTitle?: string;          // seo-review-only field, absent on technical
  revisedMetaDescription?: string;   // seo-review-only field, absent on technical
}
```

**Owner per field:** `review.technical` — Technical Reviewer only. `review.seo` — SEO Reviewer only. `review.loop.iteration` — the orchestrator only, incremented once per full loop pass (`08-retry-strategy.md`'s distinction between a module-level retry and an orchestrator-level loop iteration is unchanged and still applies here). Each reviewer's own field is overwritten on each loop pass it runs in — that's expected and is the same "latest review supersedes the prior one within this run" behavior the original design had; it is not a violation of one-writer-per-field, because it's still exactly one writer, run multiple times within one run.

## `QaSection` (Technical QA Gate — module 9, registry key `qa`)

```ts
interface QaSection {
  decision: 'pass' | 'needsRevision' | 'failClosed';
  remainingIssues: ReviewOutput['issues'];
}
```
Owned entirely by the QA Gate module. Overwritten once per loop pass (same "one writer, run repeatedly" pattern as `review.technical`/`review.seo` above) — the orchestrator reads the latest `qa.decision` immediately after each write to route the loop, so there is never a need to keep a `qa` history the way `draft` needs one (the decision itself, not its evolution, is what downstream logic needs).

## `ImagesSection` (Image Planner — module 11, registry key `image-planner`; Image Generator — module 12, registry key `image-generator`; Image Validator — module 13, registry key `image-validator`; Image Upload — module 14, registry key `image-upload`)

```ts
interface ImagesSection {
  plan?: ImagePlan;
  generated?: GeneratedImage[];
  validation?: ImageValidationResult[];
  uploaded?: UploadedImage[];
}

interface ImagePlan {
  images: { id: string; role: 'hero' | 'inline'; prompt: string; altTextDraft: string; aspectRatio: string; placementMarkerId?: string }[];
}
interface GeneratedImage {
  imageId: string; role: 'hero' | 'inline';
  data: { type: 'buffer' | 'url'; value: string };
  contentType: string;
  generationMeta: { provider: string; model: string; costUsd?: number };
}
interface ImageValidationResult { imageId: string; passed: boolean; reason?: string; retriesUsed: number; }
interface UploadedImage { imageId: string; role: 'hero' | 'inline'; assetId: string; altText: string; placementMarkerId?: string; }
```

**Owner per field:** `images.plan` — Image Planner only. `images.generated` — Image Generator only (each retry within the bounded image loop replaces that one image's entry in the array, keyed by `imageId`; it does not append a history — unlike `draft`, an image regeneration genuinely replaces a failed artifact rather than being a meaningfully reviewable revision, so no history array is warranted here). `images.validation` — Image Validator only. `images.uploaded` — Image Upload only. Four fields, four exclusive writers, no exceptions.

## `SanitySection` (Internal Link Generator — module 16, registry key `internal-links`; Portable Text Converter — module 15, registry key `portable-text`; FAQ Generator — module 17, registry key `faq-generator`; Structured-Data Readiness Validator — module 18, registry key `structured-data-check`; Sanity Document Builder — module 19, registry key `sanity-builder`)

```ts
interface SanitySection {
  resolvedLinks?: ResolvedLink[];
  portableText?: PortableTextBlock[];
  faq?: FaqItem[];
  structuredDataCheck?: StructuredDataCheck;
  document?: SanityPostDocument;
}
```
(Sub-type definitions — `ResolvedLink`, `PortableTextBlock`, `FaqItem`, `StructuredDataCheck`, `SanityPostDocument` — are unchanged from the original document's shapes and are not repeated here; see the "Migration" table below for confirmation that no sub-type shape changed, only its parent path.)

**Owner per field:** each of the five fields has exactly one writer, matching its module name one-to-one — this section was already well-factored in the original design (five distinct top-level keys, one writer each); grouping them under `sanity` changes nothing about ownership, only where they live. Sanity Document Builder's `document` field is the pipeline's one deliberate **convergence read** — it reads across `research`, `planning`, `seo`, `draft.current`, `review`, `images.uploaded`, and every other field in this section before writing its own single field — documented and accepted in `17-module-dependency-diagram.md` as the natural, expected shape of a final-assembly step, not a coupling smell.

## `PublishingSection` (Publish — module 20, registry key `publish`)

```ts
interface PublishingSection {
  documentId: string;
  publishedAt: string;
  sheetRowUpdated: boolean;
  liveUrlEstimate: string;
}
```
Write-once, and only ever written after `sanity.document` exists and Publish's idempotency check (`07-error-handling.md`, unchanged) has run.

## `MetricsSection` (moduleRunner + Logging/Metrics — modules 0c/0d)

```ts
interface MetricsSection {
  costEvents: CostEvent[];           // append-only, one per provider-call attempt — full shape in 15-cost-tracking-system.md
  totalCostUsd: number;              // a rolling sum, recomputed after every append — never hand-edited
}
```
`costEvents` is append-only by construction (`moduleRunner` pushes, nothing ever removes or mutates a past entry) — this is the pattern this revision generalizes to `errors` and `timings` below, and the reason those two are modeled as flat top-level arrays rather than nested sections: none of them belong to one module, they're cross-cutting observations *about* every module's execution, recorded by the shared `moduleRunner` wrapper, never by module code itself.

## `ErrorRecord[]` (moduleRunner)

```ts
interface ErrorRecord {
  runId: string;
  module: string;               // registry key
  errorClass: 'ValidationError' | 'ProviderError' | 'RetryableError' | 'FatalError';
  attemptNumber: number;
  message: string;
  timestamp: string;
  resolved: boolean;             // true if a later attempt succeeded; false if this error was terminal for the module
}
```
Every error, at every attempt, retried or not — recorded here, per `07-error-handling.md`'s logging discipline, now given an explicit, structured, in-state home rather than living only in free-text log output. This is what lets a `needs_review` run's Notification (module 21) attach a precise, structured error history instead of a best-effort log excerpt, and what lets `10-testing-strategy.md`'s orchestrator-level loop tests assert on exact error sequences rather than parsing log strings.

## `TimingRecord[]` (moduleRunner)

```ts
interface TimingRecord {
  runId: string;
  module: string;                // registry key
  attemptNumber: number;
  startedAt: string;
  durationMs: number;
}
```
One entry per module-call attempt — this is the data source `11-performance.md`'s "measured vs. budgeted latency" comparison actually reads from, made concrete here rather than left as "the Metrics module records this" in prose.

---

## Ownership table (every module, one row, cross-referenced to registry keys)

| Module (registry key) | Reads | Writes (exact fields) |
|---|---|---|
| Sheet Reader (`sheet-reader`) | — | `brief`, `metadata.sheetRowId` |
| Research (`research`) | `brief` | `research.*` |
| Content Planner (`planner`) | `brief`, `research` | `planning.*` |
| SEO Planner (`seo-planner`) | `brief`, `research`, `planning` | `seo.*` |
| Article Writer (`writer`) | `planning`, `seo`, `research` | `draft.current` (+ appends prior to `draft.history`) |
| Technical Reviewer (`reviewer-technical`) | `draft.current`, `research` | `review.technical` |
| SEO Reviewer (`reviewer-seo`) | `draft.current`, `seo` | `review.seo` |
| Humanizer (`humanizer`) | `draft.current`, `review.technical`, `review.seo` | `draft.current` (+ appends prior to `draft.history`) |
| QA Gate (`qa`) | `draft.current`, `review.technical`, `review.seo`, `review.loop.iteration` | `qa.*` |
| Article Improver (`improver`) | `draft.current`, `qa.remainingIssues` | `draft.current` (+ appends prior to `draft.history`) |
| Image Planner (`image-planner`) | `draft.current`, `planning` | `images.plan` |
| Image Generator (`image-generator`) | `images.plan` | `images.generated` |
| Image Validator (`image-validator`) | `images.generated`, `images.plan` | `images.validation` |
| Image Upload (`image-upload`) | `images.generated`, `images.validation` | `images.uploaded` |
| Internal Link Generator (`internal-links`) | `seo.internalLinkTargets`, `draft.current` | `sanity.resolvedLinks` |
| Portable Text Converter (`portable-text`) | `draft.current`, `sanity.resolvedLinks`, `images.uploaded` | `sanity.portableText` |
| FAQ Generator (`faq-generator`) | `draft.current`, `seo.focusKeyword` | `sanity.faq` |
| Structured-Data Readiness Validator (`structured-data-check`) | `seo`, `draft.current`, `images.uploaded`, `sanity.faq`, `metadata` | `sanity.structuredDataCheck` |
| Sanity Document Builder (`sanity-builder`) | nearly all sections (documented convergence read) | `sanity.document` |
| Publish (`publish`) | `sanity.document` | `publishing.*`, `metadata.status` *(via the orchestrator, not directly — see Metadata section above)* |
| Notification (`notify`) | `metadata`, `publishing`, `errors`, `metrics` | — (emits externally; writes nothing back to state) |
| Orchestrator | all sections | `metadata.status`, `review.loop.iteration` |
| moduleRunner (cross-cutting, every call) | — | `metrics.costEvents`, `errors`, `timings` (append-only, every module's calls pass through this wrapper) |

This table is now the single source of truth for "who owns what" — any future module added to this pipeline is required to add exactly one row here before being merged, naming its exact reads and its exact writes, as the concrete enforcement of "no module should overwrite another module's state unless explicitly documented."

---

## Migration from the flat design (old key → new path)

| Old top-level key | New path |
|---|---|
| `state.brief` | `state.brief` (unchanged) |
| `state.research` | `state.research` (unchanged shape, same path) |
| `state.contentPlan` | `state.planning` |
| `state.seoPlan` | `state.seo` |
| `state.draft` | `state.draft.current` (history now tracked in `state.draft.history`) |
| `state.technicalReview` | `state.review.technical` |
| `state.seoReview` | `state.review.seo` (its `revisedSeoTitle`/`revisedMetaDescription` fields unchanged in shape) |
| `state.reviewLoop` | `state.review.loop` |
| `state.qaGate` | `state.qa` |
| `state.imagePlan` | `state.images.plan` |
| `state.generatedImages` | `state.images.generated` |
| `state.imageValidation` | `state.images.validation` |
| `state.uploadedImages` | `state.images.uploaded` |
| `state.resolvedLinks` | `state.sanity.resolvedLinks` |
| `state.portableText` | `state.sanity.portableText` |
| `state.faq` | `state.sanity.faq` |
| `state.structuredDataCheck` | `state.sanity.structuredDataCheck` |
| `state.sanityDocument` | `state.sanity.document` |
| `state.publishResult` | `state.publishing` |
| *(none — new in this revision)* | `state.metadata.tenantId`, `state.metadata.locale`, `state.metadata.targetSite`, `state.metrics`, `state.errors`, `state.timings` |

Every reference to the old flat keys elsewhere in this architecture set (`03-module-flow.md`, `07-error-handling.md`, `08-retry-strategy.md`) should be read via this table until those documents are updated to the new paths directly — `03-module-flow.md` is updated as part of this same refinement pass; see that document's revision note at its top.

## Why this is still a zero-transformation contract

Unchanged in principle from the original document — every consumer reads a field already in the exact shape it needs, with no reshape step. The only structural change is that "the exact shape it needs" now lives at `state.sanity.portableText` instead of `state.portableText` — a deeper path, not a different shape. Sanity Document Builder still assigns `sanity.document.content = sanity.portableText` directly, no transformation, exactly as before.
