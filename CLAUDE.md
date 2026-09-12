# Blogspage Automations — Agent Handoff

> **Purpose of this file:** Cline agents load `CLAUDE.md` from the repo root at session start.
> If you are a fresh session with no prior chat history, read this file fully, then the
> canonical docs in §8, then verify the baseline (§6), then continue from §5.

---

## 1. What this project is

A modular Node.js + TypeScript **AI content automation pipeline** that turns a blog topic
brief into a complete, published article in a **Sanity CMS** (Blogspage's website) with
zero manual intervention: research → planning → SEO → draft → review → humanize →
image plan → formatting → Sanity publish.

Two purposes (same codebase):
1. **Owner's own blog engine** — writes/publishes articles for Blogspage.
2. **Resellable product** — one codebase, per-client **Client Profiles**, sold to other
   businesses by configuration (see §4 and `architecture/20`).

It talks to Sanity over the Content Lake API only; the production Next.js site is read-only.

---

## 2. Status (updated Sept 12, 2026 — Phase 3 slices 1 & 2 done)

| Phase | Status |
|---|---|
| **1 — Architecture** | ✅ DONE — 21 architecture docs incl. `20` (reselling) + `21` (cost/budget/human-in-loop) |
| **2 — Existing build** | ✅ DONE + **gate VERIFIED GREEN** (see §6) |
| **3 — Pending development** | 🚧 **IN PROGRESS** — slices 1–2 done; next slice 3 (quality layers) |

**Phase 3 slice 2 (minimal publish path) delivered — committed:**
- `internal-links` — resolves `[[link: marker]]` against `seo.internalLinkTargets` + injected
  post lookup → `sanity.resolvedLinks` (references real post `_id`s).
- `portable-text` — markdown → Blogspage Portable Text; `[[image: marker]]` → `image` blocks
  from `images.uploaded`; `[[link: marker]]` → `internalLink` annotations; unresolved markers fail.
- `faq-generator` — LLM → 3–6 validated FAQ items → `sanity.faq`.
- `structured-data-check` — required-post readiness → `structuredDataCheck`.
- `sanity-builder` — assembles `sanity.document` (seeded author/category, hero `mainImage`,
  content, FAQ, SEO fields, slug + normalized excerpt).
- `publish` **upgrade** — real idempotent write path behind `PublishGateway`: uploads staged
  images (staged bytes → authoritative `asset._id`, rewrites mainImage + inline refs),
  slug-uniqueness guard, `createPost`, records `publishing`. Protected: targets the dataset
  from env (`SANITY_DATASET`) — **the sandbox dataset only at this slice**.
- CLIs run/resume/validate wired for 15 modules; gate green: format/lint/typecheck/tests **54/774**.
- `image-planner` module + tests — LLM module producing `images.plan` from draft markers +
  angle (`src/modules/image-planner/`); deterministic validations (one hero @ 1200×630, every
  inline marker covered exactly once).
- `image-upload` module + tests — deterministic sanitize + content-derived Sanity asset refs
  (`src/modules/image-upload/`, `computeAssetReference` in `src/lib/imageHelpers.ts`).
- Orchestrator pause checkpoint — generic optional `pauseAfter` option → new result
  `kind: 'paused'`; run stops at `awaiting_assets` instead of failing.
- `attach-images` CLI + tests — `npm run attach-images -- --run-id <id> --dir <folder>`;
  strict filename-stem ↔ plan-imageId matching, copies into `storage/staging/<runId>/`,
  writes `images.staged`, returns the run to `running`.
- `src/cli/pausePolicy.ts` — shared manual-mode pause policy (`imageSource: 'manual'`), wired
  into both run/resume composition roots; profile on resume resolved from
  `metadata.clientProfileId`.
- Baseline housekeeping: `npm run check` fully green (format + lint + typecheck + tests).

**Working tree on PC at handoff:** everything above is COMMITTED and PUSHED to `origin/bentoc`.

---

## 3. Locked product decisions (from owner, mandatory)

1. **Cost budget: max $0.10/article** (target design $0.04–0.08 for margin). Owner intends ~₹10.
2. **NO AI image generation.** The pipeline produces a complete image plan only (count ~4–5 incl.
   banner, prompts, aspect ratios, placement markers). Owner supplies/uploads images manually;
   pipeline only uploads them. (Configurable per profile: `imageSource: 'manual' | 'ai' | 'none'`.)
3. **NO AI review loop.** Manual human review replaces it: approve / reject → refine. This kills
   the loop-iteration cost entirely.
4. **All modules default to CHEAP-tier models.** Tier = one config mapping in `src/config/models.ts`.
5. **Fully automated & ~free (no LLM):** markdown→Portable Text, CTA fields, excerpt, SEO metadata,
   internal links, FAQ, Sanity asset upload + idempotent publish + slug-uniqueness check. This is
   the "product" — the part the owner values most must be zero-intervention.
6. **Manual (human):** images, article review/approval, brief/ideas (Research can be skipped if the
   brief is rich).
7. **Own-company blogs first (mission pipeline), resell later** — see §4.

---

## 4. Resellability architecture (why the seams exist)

- **Client Profile** (`src/config/profiles.ts`) is the unit of sale: id/tenantId, targetSite, locale,
  prompt-overrides root (per-client brand voice = folder override, not code), llm tiers, `imageSource`,
  run-set, approvals, publish config (projectId/dataset/token), sheets, cost guardrail.
- **PublishTarget** (multi-CMS) is **deliberately DEFERRED** — Sanity-per-client is pure config
  today; a WordPress/Strapi target is built only when a real client demands it (trigger documented in `19`/`18`).
- **Per-client cost receipts** via the existing `CostEvent` pipeline → build `src/reporting/costReporter.ts` (Phase 3) to prove spend.
## 5. Phase 3 — Pending development (build order)

Complete in this order:

1. **Manual-image flow end-to-end** (owner's #1 priority) — ✅ **DONE (slice 1)**: 
   - ✅ `image-planner` module (prompts-only output; consumes `images.staged[]` handoff).
   - ✅ Pause mechanism: pipeline stops at `awaiting_assets`; `storage/staging/<runId>/` handoff dir.
   - ✅ `attach-images` CLI (`--run-id <id> --dir <path>`) gateway so uploaded files enter the pipeline.
   - ✅ `image-upload` module (manual mode) → sanitize/lint → stage → prepare for Sanity upload.
   - ✅ AI-mode kept as a profile value (`imageSource: 'ai'`), config-gated, no hardcode.
2. **Minimal publish path** (the "format & publish" product) — ✅ **DONE (slice 2)**, committed:
   - ✅ `portable-text` module (thin wrapper over existing utilities), `internal-links`, `faq-generator`,
     `structured-data-check`, `sanity-builder`.
   - ✅ Upgrade `publish` from "build artifact" → **real Sanity create** (idempotent + slug check + asset
     upload) — targets the **sandbox dataset** (env-driven `SANITY_DATASET`); see §2 slice-2 notes for the guardrail.
3. **Quality layers (FULL run-set only):** `reviewer-seo`, `qa`, `improver` + bounded review loop (max 3 iters).
4. **Notifications + Cost Reporter:** `notify` (Slack/email) + `src/reporting/costReporter.ts`.
5. **Sheet Reader module:** `sheet-reader` (SheetsClient exists; turns rows into the delivery queue).
6. **Optimization & cutover:** `tests/integration/fullPipeline.sandbox.test.ts`, first REAL provider
   end-to-end run + budget verification against the $0.10 guardrail, prompt tuning, then the
   **explicit human-approved production-dataset cutover**.

---

## 6. How to run & verify

```bash
npm run check        # THE gate: format:check + lint + typecheck + test
npm run pipeline -- "--topic \"Topic here\" --profile budget"
npm run attach-images -- --run-id <id> --dir <folder-of-images>   # manual-image handoff
npm run resume -- --run-id <id>
npm run runs         # list
npm run validate     # config/module validation (no API calls)
```

**Baseline at handoff:** `tsc --noEmit` → **0 errors** · `vitest run` → **46 files / 702 tests passed, 0 unhandled errors**.

**Windows terminal note (owner's PC):** interactive output capture can time out on long commands.
Reliable pattern — run the check detached and read its marker file:
`Start-Process cmd.exe -ArgumentList '/c (node .\node_modules\typescript\bin\tsc --project tsconfig.json --noEmit > C:\Temp\tsc.txt 2>&1) && echo PASS >> C:\Temp\tsc.txt || echo FAIL >> C:\Temp\tsc.txt' -WorkingDirectory '<repo>' -WindowStyle Hidden`
Use direct node binaries (`node .\node_modules\...`) — `npx` can hang on network.

---

## 7. Engineering gotchas (already solved — don't "fix" these)

- **CLI entry**: CLIs call `main()` guarded by `if ((import.meta as { main?: boolean }).main)` so
  importing them (tests) does NOT execute the pipeline and call `process.exit`.
- **Publisher binding** (`src/modules/publisher/publisherModule.ts`): `createPublisherModuleBinding<TServices extends object = PublisherModuleServices>()`
  is GENERIC because a concrete `Record<string, unknown>` services type breaks strict contravariance
  against `PipelineServices` in `OrchestratorModuleBinding<PipelineServices>[]`.
- **validateConfig register()**: uses `module as unknown as PipelineModule<unknown, unknown, PipelineServices>`
  (heterogeneous module union defeats generic inference).
- **ESM style**: imports use `.js` extensions; path alias `@/` → `src/` (see tsconfig).
- **Line endings**: `.editorconfig` enforces LF; git may warn about CRLF conversion (harmless).
- **No `.env` secrets exist yet** — only `.env.example`. Real end-to-end runs need a `.env` with
  OpenAI/Anthropic keys + a Sanity sandbox write token (do NOT use the production dataset).

---

## 8. Canonical reference map (read before implementing anything)

- `architecture/20-product-reselling-architecture.md` — Client Profile spec, image matrix, resale economics
- `architecture/21-cost-budget-modes-human-in-loop.md` — $0.10 budget spec, run-set profiles, HITL checkpoints
- `architecture/12-future-roadmap.md` — revised execution plan + deferred features
- `architecture/19-architecture-audit-and-readiness.md` — 93% readiness audit; PublishTarget trigger
- `architecture/03-module-flow.md` + `04-json-contracts.md` — module wiring + state contract/ownership
- `knowledge/` — the production site's schema/SEO/slug/integration contract
- `.claude/skills/blogspage-agency/SKILL.md` — concrete Sanity schema + author/category seed contract

---

## 9. First prompt for the laptop session (bootstrap)

> **Continue Blogspage Automations from the recorded handoff.**
> 1. Read `CLAUDE.md` at the repo root and follow it.
> 2. Cross-check `architecture/20-product-reselling-architecture.md`, `architecture/21-cost-budget-modes-human-in-loop.md`,
>    `architecture/12-future-roadmap.md`, and the `knowledge/` folder.
> 3. Report back: (a) where the project stands, (b) the locked decisions, (c) the Phase 3 build order.
> 4. Verify the baseline is green: `npm run check` (expect 46 files / 702 tests).
> 5. Begin **Phase 3, slice 1: manual-image flow end-to-end** per §5.