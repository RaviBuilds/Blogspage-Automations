# 11 — Performance

## What "performance" means for this system

This is not a request-latency-sensitive user-facing service — nobody is waiting on a page load. The performance goals are: (1) keep per-run wall-clock time reasonable enough that a human reviewing a `needs_review` run isn't waiting on a stuck process, (2) make sure the pipeline can scale to processing a backlog of many Sheet rows without linearly serializing every run, and (3) avoid wasted work (redundant calls, unnecessary loop iterations) that costs both time and money.

## Latency budget per run (single post, happy path, no loop iterations)

| Phase | Modules | Estimated latency | Why |
|---|---|---|---|
| Ingest | Sheet Reader | ~1–2s | Single API read |
| Research & Plan | Research → Content Planner → SEO Planner | ~15–25s | Three sequential LLM calls, each depends on the previous one's output |
| Draft | Article Writer | ~20–40s | Long-form generation (~2,800 output tokens), the single longest individual call in the pipeline |
| Review loop (1 pass) | Technical Reviewer + SEO Reviewer (parallel) → Humanizer → QA gate | ~20–30s | Reviewers run concurrently (see below); Humanizer is another long generation |
| Media | Image Planner → Image Generator (parallel) → Image Validator (parallel) → Image Upload | ~15–30s | Dominated by image-gen latency, mitigated by parallelism |
| Structure | Internal Link Generator → Portable Text Convert → FAQ Generator → Structured-Data Check | ~5–10s | Mostly deterministic/cheap-tier, fast |
| Publish | Sanity Document Builder → Publish | ~2–4s | Two Sanity API calls |
| **Total (happy path)** | | **~80–140s (roughly 1.5–2.5 min)** | |

A run with one review-loop iteration adds another ~20–30s (Article Improver + a repeated review pass). This is an acceptable latency for a scheduled/batch content pipeline — it is explicitly not optimized down to sub-10-second territory, because that would mean cutting corners on the review/humanize/image-validation steps that exist specifically to protect quality.

## Parallelization (the primary latency lever)

Restated from `06-cost-optimization.md` with the latency lens specifically:

1. **Image Generator (module 12) and Image Validator (module 13)** — every image is generated and validated independently. Running 3 images sequentially at ~8–12s each would add 24–36s to the Media phase; running them concurrently caps that phase's image-gen latency at roughly the slowest single image (~8–12s), not the sum. This is the single biggest latency win available in the pipeline and is implemented via `Promise.all` (or the equivalent bounded-concurrency primitive if the configured provider has a low per-key concurrency limit — see "Concurrency limits" below).
2. **Technical Reviewer + SEO Reviewer (modules 6, 7)** — both read only `state.draft` (and their own planning inputs), with no dependency on each other. Running them concurrently instead of sequentially removes one full review-call's latency (~10–15s) from every review-loop pass, which compounds across however many loop iterations a run needs.

Everywhere else in the pipeline, a real data dependency exists (Article Writer needs the finished outline; Humanizer needs both review results; Sanity Document Builder needs every content-producing module's output) and forcing parallelism there would require speculative/wasted work, not a genuine win — so those stages stay sequential.

## Concurrency limits (provider rate limits)

Parallel image generation and, at scale, parallel pipeline runs (multiple Sheet rows processed at once — see "Throughput" below) both risk tripping a provider's per-key rate limit if concurrency is unbounded. `src/providers/*/providerFactory.ts`-created adapters are wrapped with a bounded-concurrency semaphore (configurable per provider in `src/config/pipeline.ts`, e.g. `maxConcurrentImageGenerations: 4`) so the pipeline degrades to queuing extra work rather than hammering a provider into 429s that then have to be absorbed by `08-retry-strategy.md`'s backoff — cheaper and faster to bound concurrency proactively than to rely on retry-after-failure exclusively.

## Throughput: processing many Sheet rows

The system is designed to run one `PipelineState` per post, but nothing about a single run's design prevents running N runs concurrently, each independently persisted via `stateStore` under its own `runId`. The throughput lever is at the **orchestrator-invocation level** (`src/cli/run.ts --all-pending`, which spawns/awaits multiple independent orchestrator runs up to a configured `maxConcurrentRuns`), not inside any module. This means:

- Module code never needs to know whether it's running as part of a batch or a single invocation — it only ever sees one `PipelineState`.
- The same provider-concurrency bounding described above applies across concurrent *runs*, not just within a single run's image generation — the semaphore is shared per-provider-key, not per-run, so 5 concurrent runs each trying to generate 3 images don't accidentally create 15 simultaneous image-gen calls against a 4-concurrent-call limit.

## Caching's latency benefit (secondary to its cost benefit)

Provider-native prompt caching (`06-cost-optimization.md`) also reduces latency on cache hits for large, stable system prompts — this is a secondary benefit of a primarily cost-motivated optimization, not a separate latency initiative. The existing-posts-list cache (SEO Planner's internal-link candidates) has a more direct latency benefit: it removes a Sanity query from the critical path of most runs.

## Where NOT to over-optimize

- **Article Writer and Content Planner latency is not a target for reduction.** These are premium-tier, deliberately unhurried calls — the quality bar they exist to hit (per `06-cost-optimization.md`'s tiering rationale) is worth more than shaving 10 seconds off generation time. Streaming (mentioned in `06-cost-optimization.md`) improves *perceived* latency for a human watching, but this pipeline has no such human-in-the-loop-during-generation UI in v1, so streaming buys nothing real yet — it's noted as available, not implemented, until a use case needs it.
- **The review loop's bound (max 3 iterations) is a correctness/cost safeguard, not a latency optimization** — it happens to also cap worst-case latency, but the number 3 was chosen for "how many chances should a draft get before a human should look at it," not for a specific latency target.

## State persistence overhead

`core/stateStore.ts` writes `PipelineState` to disk (or a lightweight DB, per `12-future-roadmap.md`'s scaling note) after every module completes. This adds a small, constant per-module I/O cost (milliseconds, not seconds) in exchange for crash-resumability — a run killed mid-pipeline resumes from its last completed module rather than restarting from Sheet Reader and re-paying every LLM call's cost and latency up to that point. This trade is unambiguously worth it: the persistence overhead is negligible next to the LLM call latencies it's sitting between, and the alternative (no resumability) means any transient infrastructure failure turns into a full-cost, full-latency re-run.

## Monitoring performance in production

The Metrics module (0d) records per-module `durationMs` on every run, which is what makes the latency budget above a falsifiable claim rather than a guess — if a specific module's real-world duration drifts meaningfully from its budgeted range, that's a concrete, measurable signal (surfaced via the run summary/Notification, and available for a future dashboard per `12-future-roadmap.md`) rather than something that has to be diagnosed from scratch.
