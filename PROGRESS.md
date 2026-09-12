# Blogspage Automations — Implementation Tracker

> Single source of truth for the phased build. `CLAUDE.md` (session-start handoff) points here.
> Rule: after every slice, update this file, run `npm run check`, commit, and push.

## Status legend
`⬜ not started` · `🚧 in progress` · `✅ done` · `⏸ deferred` (trigger-gated)

## Phase 3 — Core pipeline completion (↓ = next)

| # | Slice | Status | Commit | Date | Tests (gate) |
|---|---|---|---|---|---|
| 1 | Manual-image flow end-to-end | ✅ | `165c924` | 2026-09-12 | 49 files / 740 |
| 2 | Minimal publish path (portable-text, internal-links, faq-generator, structured-data-check, sanity-builder, real idempotent Sanity publish → sandbox) | ✅ | `c883925` | 2026-09-12 | 54 files / 774 |
| 3 | Quality layers (reviewer-seo, qa, improver + bounded loop; enforce run-set gating) | ✅ | `af4b5a8` | 2026-09-12 | 58 files / 790 |
| 4 | HITL article approval (needs_review → approve/reject, bounded refine) | ⬜ | — | — | — |
| 5 | Sheet Reader module (queue → brief → row status lifecycle) | ⬜ | — | — | — |
| 6 | Notifications + Cost Reporter (receipt on every notification) | ⬜ | — | — | — |
| 7 | Sandbox e2e test + budget verification (≤ $0.10/article) | ⬜ | — | — | — |
| 8 | Production cutover (human-gated only) | ⬜ | — | — | — |

## Phase 4 — Resale hardening (all ⏸, trigger-gated — see `architecture/20`, `architecture/12`)

| Item | Status | Trigger |
|---|---|---|
| Multi-CMS `PublishTarget` | ⏸ | a second real CMS client |
| Per-tenant stateStore / real DB | ⏸ | concurrent multi-tenant runs |
| Client dashboard / API | ⏸ | paying clients ask |
| Billing metering | ⏸ | first non-Sheet billing requirement |

## Standing deferrals (never build without trigger — `architecture/12` Part 1)
Streaming provider responses · prompt A/B testing · LLM-as-judge harness ·
provider batch scheduling · multi-post-type support · auto category creation ·
on-demand revalidation webhook (client-side)

---

## Per-slice records

### Slice 1 — Manual-image flow end-to-end ✅ `165c924`
- `image-planner` (LLM → `images.plan`; one hero @ 1200x630; inline markers covered exactly once)
- Orchestrator pause checkpoint (`pauseAfter` → `kind: 'paused'`, `awaiting_assets`)
- `attach-images` CLI → `storage/staging/<runId>/` + `images.staged`, resumes run to `running`
- `image-upload` (sanitize + deterministic `image-<sha1>-<w>x<h>-<ext>` asset refs)
- `pausePolicy.ts`, gate green (49/740), pushed

### Slice 2 — Minimal publish path 🚧
**Definition of done:** draft → `sanity.portableText` (image/CTA blocks resolved) → `sanity.faq` →
`structuredDataCheck` → `sanity.document` → **real idempotent Sanity `create`** (slug-uniqueness,
asset upload) against the **sandbox** dataset; run + resume CLIs stop treating publish as a stub.

Sub-steps (updated as they land):
- ✅ `internal-links` — resolves `[[link: marker]]` via seo targets + injected post lookup → `sanity.resolvedLinks`
- ✅ `portable-text` — markdown → Portable Text; `[[image: marker]]` → image blocks (from `images.uploaded`), `[[link: marker]]` → internalLink annotations
- ✅ `faq-generator` — LLM → 3–6 validated FAQ items → `sanity.faq`
- ✅ `structured-data-check` — required-post readiness → `structuredDataCheck`
- ✅ `sanity-builder` — assembles `sanity.document` (seeded author/category, hero mainImage, content, FAQ, SEO)
- ✅ `publish` upgrade — real idempotent path via `PublishGateway`: asset upload (staged bytes → real `asset._id`, refs rewritten), slug-uniqueness guard, `createPost`, records `publishing`
- ✅ CLIs wired (15 modules), services include read/write Sanity clients + gateway
- ✅ GATE green (`npm run check`: format/lint/typecheck/tests 54 files / 774 tests) — committed

### Slice 3 — Quality layers ✅
**Definition of done:** `reviewer-seo`, `qa`, `improver` modules + bounded review loop (max 3 iters) +
run-set gating (full/budget/minimum select module subsets at the composition root).

Sub-steps:
- ✅ `reviewer-seo` — LLM review of humanized draft vs seo strategy → `ReviewOutput { passed, issues[] }`
- ✅ `qa` — LLM + hard structural checks (word count, required sections, no leftover markers) → `QaSection`; `failClosed` → `needs_review`
- ✅ `improver` — LLM repair pass consuming review/QA issues → bounded draft revision (history appended)
- ✅ Orchestrator `loopAfter` → bounded review loop (max 3 iters); exits to `needs_review` on exhaustion (checkpointed)
- ✅ `reviewLoopPolicy.ts` — config-driven loop policy wired into run/resume CLIs
- ✅ Run-set gating enforced at composition root (full includes quality modules; budget/minimum exclude them)
- ✅ GATE green (58 files / 790 tests) — committed