# 21 — Cost Budget Modes & Human-in-the-Loop

> **Added in the productization pass (2026-09-11).** The owner's hard requirement for their own blog runs: **no more than ≈ $0.10/article (₹10) in API spend**, with everything *formatting-and-publishing* automated at zero intervention and the *creative/manual* steps (article review, image sourcing) done personally. This document is the canonical cost and human-in-the-loop design. It sits on the cost data layer of `15-cost-tracking-system.md`, the tier system of `06-cost-optimization.md`, and the Client Profile mechanism of `20-product-reselling-architecture.md`.

## The budget constraint

Current documented estimate for a full run with AI images: **≈ $0.404/article** (`06-cost-optimization.md`). Budget: **≤ $0.10/article**; design target **$0.04–0.08** to leave room for a retry or one approval round.

## The three cuts that make $0.10 possible

| Cut | What changes | Saves (vs. Anthropic baseline) | Running total | Nature |
|---|---|---|---|---|
| 1 — **No AI image generation** (manual source) | drop `image-generator` + `image-validator`; keep `image-planner` (prompts) | ≈ $0.162 | ≈ $0.242 | config: `imageSource: 'manual'` |
| 2 — **No AI review loop** (human review replaces it) | drop `reviewer-technical` / `reviewer-seo` / `qa` from the budget run-set | ≈ $0.021 + **all loop-iteration cost** | ≈ $0.221 | config: `runSet: 'budget'`, `approvals.article: true` |
| 3 — **Cheap-tier models** | every module on CHEAP (mini/Haiku-class) instead of STANDARD/PREMIUM | ≈ $0.15 | **≈ $0.05–0.08** | config: `llmTiers` / `models.ts` |

**All three cuts are configuration, not module changes.** Cut 3 is the non-negotiable one: after cuts 1–2 the run is still ≈ $0.22 — double the budget — so cheap-tier mapping is mandatory in budget mode.

## Run-set profiles

| Run-set | Modules beyond the always-on core | Approvals | Images | Est. cost |
|---|---|---|---|---|
| **FULL** (client product mode) | research, planner, seo-planner, writer, reviewer-technical, reviewer-seo, humanizer, qa, improver, image-planner, image-generator, image-validator, image-upload, internal-links, faq-generator, portable-text, structured-data-check, sanity-builder, publish, notify | outline on/off | `ai` (or per client) | ≈ $0.40+ |
| **BUDGET** (owner default) | research, planner, seo-planner, writer, humanizer (CHEAP), image-planner → image-upload (manual), internal-links, faq-generator, portable-text, structured-data-check, sanity-builder, publish | article on | `manual` | **≈ $0.04–0.08** |
| **MINIMUM** (leanest) | BUDGET minus research (owner supplies brief + ideas) minus humanizer | article on | `manual` | ≈ $0.03–0.05 |

The always-on core — sheet-reader/CLI brief, portable-text conversion, CTA/SEO assembly, structured-data-check, sanity-builder, publish, metrics/logging — is **≈ $0.00/article** (no LLM tokens). The part the owner rates highest ("formatting and inserting into Sanity") is the part that is fully automated *and* essentially free.

## Configuration surface (all in `src/config/profiles.ts`)

- `imageSource: 'manual' | 'ai' | 'none'`
- `runSet: 'full' | 'budget' | 'minimum'`
- `approvals: { outline: boolean; article: boolean }`
- `llmTiers`: per-module tier overrides (budget pins every LLM module to `CHEAP`)
- `costGuardrail: { maxCostUsd?: number }` — the orchestrator checks `metrics.totalCostUsd` between modules and stops the run if the cap is exceeded → `needs_review` + notification

## Human-in-the-loop checkpoints (the designed manual steps)

| Checkpoint | When | What the human does | Mechanism |
|---|---|---|---|
| **Outline approval** (optional, off by default) | after `planner` | approve or edit the outline | resume machinery + a reserved `awaiting_outline` status |
| **Article approval** (owner default) | after draft + formatting, with a full formatted preview | **approve → publish path; reject → bounded refine** | this *replaces* the AI review loop in budget mode |
| **Image handoff** | after `image-planner` when `imageSource: 'manual'` | upload files (or paste URLs) via `attach-images --runId <id> --dir <path>` | status `awaiting_assets` + `images.staged` (`04-json-contracts.md`) |

None of these need new orchestration — they extend the Phase-6 pause/resume with status values and a gateway CLI. Two of the three (article review, image sourcing) are already the owner's stated workflow.

## Status model change

`PipelineStatus` (`04-json-contracts.md`) gains **`awaiting_assets`** (and reserves `awaiting_outline`). Transition: `running` → `awaiting_assets` (image handoff) → `running` (on attach/resume) → … → `published` | `needs_review` | `failed`. Status writes remain exclusively the orchestrator's.

## Cost guardrails (hard stops, not hopes)

1. `costGuardrail.maxCostUsd` — abort between modules once `metrics.totalCostUsd` exceeds the cap.
2. Bounded retries (existing backoff config) and bounded review/image loops (existing `maxReviewIterations` / `maxImageRetries`).
3. Per-profile receipts via the Cost Reporter (`15`) — "we are in budget" is a measured per-run fact, not an estimate.

## Verification

Every run records a `CostEvent` per LLM/image call (`15-cost-tracking-system.md`); `metrics.totalCostUsd` accumulates them. Combined with `costGuardrail.maxCostUsd`, the budget is enforced at runtime, and the Cost Reporter turns the same data into a per-run/per-profile receipt. These are the numbers that answer "are we inside $0.10?" — measured, not hoped.

## Open decisions (resolve at implementation, not here)

- **Exact cheap-model mapping** for `models.ts` in budget mode — needs a live pricing check at integration time (Anthropic Haiku-class is the documented baseline; OpenAI mini-class is cheaper; either way the estimates above hold only for mini/Haiku-class per-token pricing — record the real numbers via `pricingVerifiedAt`).
- Whether **humanizer stays in BUDGET** (≈ $0.005–0.02 on CHEAP; buys style) or moves to an on-demand polish step.
- Whether **research stays in BUDGET** or the owner supplies the brief + ideas (MINIMUM, ≈ $0.005 saved).