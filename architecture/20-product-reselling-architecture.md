# 20 — Product Reselling & Multi-Client Architecture

> **Added in the productization pass (2026-09-11).** This document is the canonical home for a decision made after the v1 audit (`19-architecture-audit-and-readiness.md`): this software is **both** the owner's own blog-publishing automation for Blogspage Agency **and** a resellable product for agency clients, so every difference between two customers must live in **configuration or prompt overrides, never in module code**. It works alongside `21-cost-budget-modes-human-in-loop.md` (how much a run costs and which steps are manual). It also revises exactly one deferral from `18-scalability-and-future-features.md`: multi-site publishing for the **Sanity** case stops being future work and becomes a config-only capability (a Client Profile per site); only multi-*CMS* publishing remains deferred.

## The product decision (the premise for every later section)

Two owners, one codebase:

1. **The owner's own site** — Blogspage Agency's blog runs through this pipeline on a hard cost budget (≤ $0.10/article, `21-cost-budget-modes-human-in-loop.md`), with manual article review and manual images.
2. **Agency clients** — the same engine pointed at each client's CMS/dataset/models/brand voice, priced per-article or per-month.

The single architectural rule this decision imposes: **no `if (client === 'X')` anywhere in module code.** Every customer difference is a value in the Client Profile (`src/config/profiles.ts`) or a file in the prompt override tree (`src/prompts/overrides/`). The content modules are already CMS-agnostic by construction (`18-scalability-and-future-features.md` § Multiple websites); this document makes the binding layer concrete.

## The Client Profile (`src/config/profiles.ts`)

An immutable, typed object binding every per-customer decision for one run. The CLI accepts `--profile <id>`; the process `Config` (`src/config/env.ts`) is loaded *from* the chosen profile plus process env (env carries secrets; the profile carries everything else).

| Field | Type / shape | Owner's default | Notes |
|---|---|---|---|
| `id` / `tenantId` | string | `blogspage` | mirrors the reserved `metadata.tenantId` |
| `displayName` | string | `Blogspage Agency` | logs/reports only |
| `targetSite` | string | `blogspage` | already in `metadata`; the publish config below targets it |
| `locale` | string | `en` | already in `metadata`; drives the prompt override axis (`13-prompt-management-system.md`) |
| `promptOverridesRoot` | path | `src/prompts/overrides/` base | tenant override folders already supported by `lib/prompts.ts` (`buildOverrideCandidates`: tenant-locale → tenant → locale → base) |
| `llmTiers` | per-module tier overrides | `{}` (fall back to `models.ts`) | lets a profile pin any module to a tier, e.g. budget pins everything to `CHEAP` |
| `imageSource` | `'manual' \| 'ai' \| 'none'` | `manual` | which media modules run — full matrix below |
| `runSet` | `'full' \| 'budget' \| 'minimum'` | `budget` | module subset + checkpoints — `21-cost-budget-modes-human-in-loop.md` |
| `approvals` | `{ outline: boolean; article: boolean }` | `{ outline: false; article: true }` | human-in-the-loop checkpoints — `21` |
| `publish` | per-CMS config | Sanity `{ projectId, dataset, writeToken, apiCdn }` | the v1 resale mechanism: one Sanity project pair per client |
| `sheets` | `SheetsClientConfig \| null` | `null` (CLI `--topic`) | per-client queue spreadsheet (`src/config/sheets.ts`) |
| `costGuardrail` | `{ maxCostUsd?: number; maxReviewIterations?: number; maxImageRetries?: number }` | `{ maxCostUsd: 0.10 }` | hard stop → `needs_review`/`failed` — `21` |

`metadata.clientProfileId` records which profile a run used (additive, seeded by the orchestrator at run start — `04-json-contracts.md`).

## What reselling actually touches (honest inventory)

| Layer | Status after this pass |
|---|---|
| Content modules (`research` … `faq-generator`) | **Zero changes** — CMS-agnostic by design |
| Prompt Registry override axis (`overrides/<tenant>/…`) | Already **built** (`lib/prompts.ts`, tested) |
| Provider factory tenant parameter | Already **built** (`providerFactory.getProvider(tier, config, tenantId)`) |
| `metadata.tenantId` / `targetSite` / `locale` | Already **built** (`src/core/state.ts`) |
| Client Profile binding layer | **New** — `src/config/profiles.ts`, profile loader, CLI `--profile` |
| `metadata.clientProfileId` + `awaiting_assets` + `images.staged` | **New** — `04-json-contracts.md`, `core/state.ts` |
| Per-client stateStore isolation | **Gated** (deferral table below) |
| `PublishTarget` for non-Sanity CMS | **Designed, unbuilt** (`18`); per-client Sanity config covers Sanity customers |
| Client-facing UI/API | **Deferred** — the client's Google Sheet *is* the v1 UI (Sheet Reader queue + status column) |
| Per-client cost reporting | **Designed** (`15`); profiles give the reporter the `clientProfileId` dimension |

## Image strategy as a profile option

Image **generation** is optional per client by design — your budget mode and a client's AI mode are two values of one config:

| `imageSource` | Modules that run | Human effort | Cost/article |
|---|---|---|---|
| `manual` (owner default) | `image-planner` (prompts only) → **pause `awaiting_assets`** → human attaches files → `image-upload` uploads them | human sources 4–5 images | ≈ $0.004 |
| `ai` (client option) | `image-planner` → `image-generator` → `image-validator` → `image-upload` | none | ≈ $0.15–0.40 |
| `none` | no image modules | n/a | $0 |

The pause/resume is the existing Phase-6 checkpoint machinery (`core/stateStore.ts`, `src/cli/resumePipeline.ts`), extended with one new status (`awaiting_assets`) and one new CLI gateway (`attach-images`). The media modules are **built config-gated from day one** so this remains a config value forever, never a refactor.

## PublishTarget: revised deferral status

For Sanity customers — the realistic majority of a web agency's client base — **a per-client Sanity config is enough and needs no new abstraction**. The `PublishTarget` interface (`18-scalability-and-future-features.md` § Multiple websites) therefore stays **designed, not built**, with its original trigger made sharper: *a real client on a second CMS platform (WordPress, Strapi, Contentful, …)*. When built, it replicates the proven `LLMProvider` pattern (interface at the boundary, adapter behind it) and affects only the final assembly/publish modules — exactly as `18` documents. Nothing in this pass changes that.

## Per-client cost reporting

`CostEvent` is already per-run with `moduleKey` (`15-cost-tracking-system.md`). The planned Cost Reporter adds `clientProfileId` as a grouping dimension, so per-client spend is a report filter, not a schema change. For the owner this doubles as budget verification (`21` § Verification).

## Resale economics (what you are actually selling)

The expensive thing this project builds — valid Sanity Portable Text, complete SEO/CTA assembly, safe idempotent publishing — is **config-reusable with near-zero marginal API cost per extra client**. Per-client marginal cost after the build: configuration, not development. Pricing models to consider at launch: one-time setup plus per-article API pass-through, or a flat monthly per client at a fixed volume. API cost varies by the client's profile mode (≈ $0.05–0.50/article — `21`), which is a rounding error next to the manual cost of one formatted, published post.

## Deferred (with triggers) — restated for product context

| Item | Trigger | Today |
|---|---|---|
| Multi-CMS `PublishTarget` | a second real CMS client | per-profile Sanity config covers v1 |
| Per-tenant `stateStore` isolation / real DB | concurrent multi-tenant runs, or legal separation | one host, one storage dir, profile-tagged runs |
| Client dashboard / API | paying clients ask for one | the client's Sheet is the UI |
| Multi-tenant billing metering | first non-Sheet billing requirement | `CostEvent` + future reporter are the data layer |