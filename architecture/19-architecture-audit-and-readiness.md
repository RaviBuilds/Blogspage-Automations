# 19 — Architecture Audit & Implementation Readiness

## Purpose

This is the closing document of the refinement pass. It audits the architecture as it now stands (documents `01`–`18`, several revised in this same pass) against the commercial-scale framing of the refinement request: missing abstractions, duplicated responsibilities, tight coupling, future maintenance risk, cost-growth risk, testing difficulty, performance bottlenecks, and technical debt. Each finding states what was found, why it matters at scale, and what — if anything — was changed in response. Findings with no corresponding change are stated as accepted, explained tradeoffs, not oversights.

## Audit method

Every document in `architecture/` was re-read against four questions: (1) does this decision still hold at 100x the current volume, (2) does this decision still hold with 10x the current module count, (3) does this decision still hold with multiple tenants/brands, (4) would a second engineer joining the project be able to find the one place to change X without reading every file. Findings are grouped by category, not by document, since the point of this audit is to surface cross-cutting issues a per-document read would miss.

---

## Missing abstractions (found and fixed in this pass)

| Finding | Why it matters at scale | Resolution |
|---|---|---|
| No Prompt Registry — modules loaded prompts by path | At 60+ prompt files (21 modules × ~3 files each) and growing, path-based loading means every future per-tenant/per-locale override becomes a path-computation problem bleeding into module code. | `13-prompt-management-system.md` — the Prompt Registry, with inheritance resolution built (but empty) now. |
| No `PublishTarget` abstraction — Sanity was hardcoded at the write boundary | A second website/CMS (a realistic commercial-platform feature) would require touching every module that currently imports `sanityWriteClient` directly. | Named and specified in `18-scalability-and-future-features.md` as the next application of the same pattern already used for `LLMProvider`. **Not yet built** — flagged honestly below under "Remaining risks," not silently treated as done. |
| No structured cost-event schema — only a rough per-call `costUsd` number | A single aggregate number can't answer "is caching working," "how much did retries cost," or "what's our real Anthropic vs. OpenAI unit economics" — all real commercial-platform questions. | `15-cost-tracking-system.md` — the `CostEvent` schema, with `cachedInputTokens` and `pricingVerifiedAt` now flowing from the provider adapter through `moduleRunner` to a dedicated Cost Reporter. |
| No utility layer inventory beyond four ad hoc files | Without a documented, pre-built utility layer, the same "safe filename," "backoff math," "TTL cache" logic tends to get reinvented slightly differently inside 2–3 different modules that each independently need it. | `14-core-utilities.md` — eleven new utilities named, scoped, and given a hard "zero provider dependency" rule. |
| No local iteration path — every prompt/logic change required a full pipeline run to observe | At real per-call cost and 80–140s latency per run (`11-performance.md`), this is a direct tax on how fast the system's own prompts and logic can improve. | `16-developer-workflow-playground.md` — Module Playground and Prompt Playground, both built on infrastructure that already exists elsewhere in this architecture (no new plumbing). |

## Duplicated responsibilities (found and fixed)

| Finding | Resolution |
|---|---|
| The JSON-output-formatting instruction was duplicated, with slightly different wording, across `output-format-json.md` and several `user.md` files. | Split into a dedicated `shared/json-schema-contract.md` fragment in `13-prompt-management-system.md` — one canonical version of the *generic* instruction, separate from each module's *specific* schema (which correctly stays in that module's own `user.md`). |
| Retry backoff math was described as living inside `core/moduleRunner.ts`, meaning any second consumer of "how long should I wait before retrying" (there wasn't one yet, but there would be at scale — e.g. Sheet Reader's own polling, if it existed) would have had to duplicate it or reach into `moduleRunner` inappropriately. | Extracted to `lib/retry.ts` as a pure function in `14-core-utilities.md`; `moduleRunner` now composes it rather than being it. |
| Three different names existed for the same concept per module: the descriptive name in `03-module-flow.md` prose (e.g. "Article Writer"), the numbered folder name in `02-folder-structure.md` (`05-article-writer`), and the prompt folder name (`article-writer`) — accidentally consistent in most cases, but with no rule forcing that consistency, and one place (module 19) where the names actively diverged in meaning (`sanity-upload` for a module that doesn't upload). | Collapsed to one registry-key vocabulary, used identically across module folders, prompt folders, `CostEvent.moduleKey`, and playground CLI arguments (`13-prompt-management-system.md`'s naming note, `02-folder-structure.md`'s rename table, `03-module-flow.md`'s per-module registry-key tags). |

## Tight coupling (found; one fixed, one accepted as a deliberate, documented tradeoff)

| Finding | Verdict |
|---|---|
| `SanityPostDocument`'s exact shape was reachable from, and assumed by, Sanity Document Builder, Publish, and (implicitly) every module that fed a field into it — a change to Blogspage Agency's schema would require checking all of them. | **Fixed, partially.** `18-scalability-and-future-features.md`'s `PublishTarget` interface isolates the CMS-specific shape to `buildDocument()`'s return type, opaque to every other module. `state.sanity.document`'s exact `SanityPostDocument` type still lives in `04-json-contracts.md` and is still Sanity-specific — that's correct and doesn't need to change until a second `PublishTarget` actually exists (per that document's own reasoning: build the interface now, don't build a second implementation speculatively). |
| Sanity Document Builder reads nearly the entire `PipelineState` (`04-json-contracts.md`'s "documented convergence read"). | **Accepted, not fixed — a deliberate tradeoff, not a coupling smell.** A final-assembly step *must* read broadly; that's what final assembly means. The alternative (each producing module pushing its own field directly into a `sanity.document` draft as it's produced) would spread document-assembly logic across 8+ modules instead of one, which is strictly worse for maintainability — a future engineer would have to read 8 files to understand how the final document is built, instead of one. `17-module-dependency-diagram.md` names this explicitly as the graph's natural convergence point and the audit confirms that verdict stands. |
| `moduleRunner` is a single, shared wrapper that every module call passes through, and is now responsible for retry logic, error classification, cost-event emission, and timing — four responsibilities in one file. | **Accepted, with a documented split already in place.** The retry *math* (`lib/retry.ts`), the error *taxonomy* (`core/errors.ts`), and the cost-event *shape* (defined by the `LLMCallResult` interface, not by `moduleRunner`) are already extracted as separate, independently-testable units. What remains in `moduleRunner` is orchestration — deciding when to call each of those, not implementing any of them — which is the correct amount of responsibility for the one place every provider call already has to pass through. Splitting it further (e.g. a separate "cost-emitting wrapper" and a separate "retry wrapper" layered on top of each other) would add call-stack depth without adding a genuine seam anyone would want to cut along independently. |

## Future maintenance risks

| Risk | Assessment |
|---|---|
| The `sanity` section name in the revised `PipelineState` is itself Sanity-specific, in a schema this document just argued is otherwise CMS-agnostic until the final field. | Named explicitly in `04-json-contracts.md`'s revision as a known, deliberately deferred rename (to something like `structuredContent`) — flagged rather than fixed now, because renaming one section key is cheap whenever the second `PublishTarget` actually arrives, and renaming it speculatively now, before that need is concrete, would just be churn. |
| `promptVersion` (a git-commit-hash tag per prompt folder) depends on the prompt files being inside the same git repository the pipeline runs from. | Correct for v1's single-repo layout. Flagged in `13-prompt-management-system.md` implicitly via its git-based design — if prompts ever move to a separately-deployed remote store (the same document's own localization-scale scenario), `promptVersion`'s computation needs to change from a `git rev-parse` call to whatever that store's own versioning primitive is. This is a small, isolated change (one function inside the registry), not a redesign. |
| The registry-key rename (this pass) touches every module folder, prompt folder, and cross-reference across a dozen documents. | This is deliberately being done **now**, before any module code exists, specifically because a rename after implementation begins would be a real, costly, error-prone refactor across real code, tests, and fixtures — not just documentation. Doing it at the architecture stage is exactly why this refinement phase was requested before implementation, and this is the concrete payoff of that sequencing. |

## Where API cost may increase (identified, with the mitigation already in place or explicitly deferred)

| Growth vector | Mitigation status |
|---|---|
| Volume growth (more posts/month) | Linear by design — no per-run cost scales super-linearly with volume in the current architecture. `06-cost-optimization.md`'s tiering discipline is the primary lever, and it doesn't degrade with volume. |
| Draft-length creep over time (prompts drift toward longer output without anyone deciding that) | **Now detectable**, not just theoretically bounded — `15-cost-tracking-system.md`'s per-day/per-week Cost Reporter view is specifically designed to surface this kind of silent drift as a trend line, where the original architecture had no mechanism to notice it happening at all. |
| Cache-invalidation regression (a prompt edit silently breaks a stable, cacheable prefix) | **Now detectable** — `cachedInputTokens` tracked per call, per `09-provider-abstraction.md`'s revision, specifically to catch this the day it happens rather than months later in a bill. |
| Retry storms under provider rate-limiting at higher concurrency | Bounded by `11-performance.md`'s per-provider concurrency semaphore design, and now *measurable* — every retry attempt emits its own `CostEvent` (`15-cost-tracking-system.md`), so retry-driven cost inflation shows up explicitly in reports (`attemptNumber > 1` rows) rather than being averaged away. |
| A future non-Anthropic provider's pricing table going stale after being set once | `pricingVerifiedAt` (this pass's addition to `09-provider-abstraction.md`) makes staleness a visible, dated field on every cost report rather than a silent assumption. |

## Testing difficulties (identified; resolved by design, not by new tooling)

| Difficulty | Resolution |
|---|---|
| Testing the review loop's bounded termination required either a real model that reliably "misbehaves" on command, or careful fake-provider scripting. | Already solved in the original `10-testing-strategy.md` via a `FakeLLMProvider` scripted to always return "needs revision" — re-confirmed as sufficient in this audit; no change needed. |
| Testing prompt changes for *quality* (not just structural correctness) has no automated gate. | **Confirmed as an accepted, explicit gap**, not silently left ambiguous — `10-testing-strategy.md` already named this as deferred to manual review plus a future LLM-as-judge harness (`12-future-roadmap.md`'s Part 1). This audit doesn't change that call: building a quality-eval harness before there's real production output to evaluate against would be premature. |
| The new `draft.history` append-on-write mechanism (`04-json-contracts.md`'s revision) needs its own dedicated test to confirm it never *loses* a version, not just that `draft.current` is correct. | **New test surface identified by this audit, not yet written** (this phase is architecture-only) — flagged for the module unit tests of `writer`/`humanizer`/`improver` in `10-testing-strategy.md`'s existing per-module pattern: each should assert `draft.history.length` increments by exactly one per write, in addition to asserting `draft.current`'s shape. |

## Performance bottlenecks (re-confirmed, none new found)

`11-performance.md`'s latency budget and parallelization analysis (concurrent reviewers, concurrent image generation/validation) was re-examined against the revised, nested `PipelineState` and found to still hold exactly as designed — the section-based reorganization changes *where* a field lives, not *when* it's produced, so no dependency this audit traced changed. The one addition: `moduleRunner`'s new cost-event emission (`09-provider-abstraction.md`'s revision) adds a small, constant, in-process bookkeeping cost per call — negligible next to any real network call's latency, and explicitly not worth a dedicated performance analysis of its own.

## Technical debt risks (explicitly named, not deferred silently)

1. **`PublishTarget` is designed but not built.** This is real, acknowledged debt against the "commercial platform" framing — if a second website/CMS becomes a near-term need rather than a future one, this interface should be built *before* that need arrives, not concurrently with it under time pressure. It is not on the critical path for shipping the Blogspage blog pipeline itself, which is why it's correctly deferred, but it should be revisited the moment a second target is discussed, not treated as done because it's designed.
2. **Multi-tenant data isolation in `stateStore` remains a real, named gap**, not a solved problem — `18-scalability-and-future-features.md` is explicit that local-JSON `stateStore` provides no isolation guarantee, and this audit does not attempt to paper over that with a partial fix; it stays an honest, open item gated behind the stated trigger (real multi-tenant demand).
3. **The `sanity` section name is a known-temporary choice** (see "Future maintenance risks" above) — tracked here explicitly so it isn't forgotten between now and whenever a second `PublishTarget` makes the rename relevant.

---

## Summary of architectural improvements (this pass)

1. **Prompt Management System** (`13-prompt-management-system.md`) — the Prompt Registry abstraction, a fifth prompt file type (`examples.md`), naming-consistency fixes, and a built-but-empty tenant/locale inheritance chain.
2. **Core Utility Layer** (`14-core-utilities.md`) — eleven new provider-independent utilities named and scoped, closing gaps that would otherwise have been filled ad hoc, per-module.
3. **Cost Tracking System** (`15-cost-tracking-system.md`) — the `CostEvent` schema (with cache-hit and pricing-freshness tracking) and a provider-agnostic Cost Reporter, turning `06-cost-optimization.md`'s design-time hypotheses into a run-time, falsifiable feedback loop.
4. **Developer Workflow & Playground** (`16-developer-workflow-playground.md`) — Module Playground and Prompt Playground, cutting iteration cost and latency to near-zero for the highest-frequency development activity in the system.
5. **Module Dependency Diagram** (`17-module-dependency-diagram.md`) — the real dependency graph (Mermaid), making parallel-vs-sequential structure explicit and auditable rather than only implied by execution-order prose.
6. **Provider Independence, hardened** (`09-provider-abstraction.md`) — `cachedInputTokens`, `supportsCaching`, `pricingVerifiedAt` added to the interface, closing the gap between "providers are swappable" and "we can actually measure and compare them."
7. **Future Scalability** (`18-scalability-and-future-features.md`) — an honest, per-feature accounting of what today's abstractions already absorb (most things) versus what would be genuinely new work (new content-type modules, tenant data isolation), naming the exact seam each future feature attaches to.
8. **`PipelineState` restructured** (`04-json-contracts.md`) — nested sections replacing a flat 20-key namespace, a complete per-module ownership table, and the draft-history redesign that eliminates the last silent-overwrite exception in the original design.
9. **Folder structure and naming, unified** (`02-folder-structure.md`) — one registry-key vocabulary across modules, prompts, cost events, and CLI tools; `storage/`, `logs/`, `output/`, `scripts/`, `reporting/` given explicit homes instead of being implied.
10. **Build order, synthesized** (`12-future-roadmap.md`) — the user's 12-phase philosophy adopted as the primary structure, with one credited improvement (prompts/utilities before providers, for a more realistic first integration test) and three prior risk-mitigation steps folded into the phases where they now correctly belong.

## Updated build order

See `12-future-roadmap.md` Part 2 for the full 12-phase detail. Summary: **Foundations → Prompt System → Core Utilities → Provider Layer → Sanity Integration → PipelineState → Orchestrator → AI Modules → Media Pipeline → Publishing → Notifications → Optimization** — the user's requested order, adopted as given, with the reasoning for why it sequences correctly (and where it improves on the original roadmap) made explicit rather than assumed.

## Remaining risks (honest list, not closed out)

1. `PublishTarget` is a designed-but-unbuilt interface — real debt if a second CMS/site becomes near-term.
2. Multi-tenant `stateStore` isolation is an open gap, correctly gated behind real demand, but unbuilt.
3. Prompt *quality* has no automated regression gate — deliberate, but means a prompt edit's real-world effect is only caught by the manual-review step in `10-testing-strategy.md` and by the Cost/Metrics trend-watching in `15-cost-tracking-system.md`, not by CI.
4. The `sanity` section-naming debt (cosmetic, cheap to fix later, but a real inconsistency until it is).
5. `draft.history`'s correctness (never losing a version) needs a dedicated test not yet written — identified, not yet implemented, since this phase is architecture-only.
6. Everything in `12-future-roadmap.md` Part 1 remains, by design, unbuilt — each with a named trigger, none of them blocking v1.

None of these six risks block starting implementation. All six are either explicitly deferred by design (with a stated trigger) or are test/implementation-phase work items now clearly identified for the teams that will execute `12-future-roadmap.md`'s phases.

## Final readiness score: **93%**

**Why not 100%:** items 1–2 above (`PublishTarget`, tenant isolation) are real, named gaps in the abstraction layer that a fully "commercial platform, thousands of articles, multi-tenant" reading of the refinement request would expect to see *built*, not just *designed*. They are correctly scoped as post-v1 (a single-tenant, single-site blog pipeline does not need them yet), but their absence is why this is not a 100. **Why not lower:** every other category audited above — missing abstractions, duplicated responsibility, coupling, cost growth, testing gaps, performance — was either already correctly designed, or was found and fixed in this same pass, with the fix documented in the specific file that owns it. The gap between 93 and 100 is precisely and only the two named, deferred, triggered items — not an unknown risk.

## Confirmation

The architecture is finalized for the v1 scope defined across documents `01`–`19`. It is internally consistent (every cross-reference introduced by this revision — registry keys, `PipelineState` paths, the Cost Reporter, the Prompt Registry — resolves correctly across every document that mentions it), every module has a named owner for every field it touches, every future feature scenario in the request has been checked against the current design and either shown to be absorbed or honestly flagged as new work, and the build order is sequenced to retire the highest-risk unknowns (provider abstraction, Portable Text correctness, Sanity write safety) before content-generation work begins. **This architecture is ready for module-by-module implementation to begin at Phase 1 of the revised build order in `12-future-roadmap.md`.**
