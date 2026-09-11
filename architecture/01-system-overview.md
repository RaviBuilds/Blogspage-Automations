# 01 — System Overview

> **Revision note:** This refinement pass (architecture-hardening for commercial scale, not implementation) touched the `PipelineState` shape (`04-json-contracts.md`, now nested), the provider interface (`09-provider-abstraction.md`, cost/caching fields added), the folder structure and module naming (`02-folder-structure.md`, registry-key convention), and added six new documents (`13`–`18`) plus a final audit (`19`). This document's Purpose, Design Goals, and high-level flow are unchanged — the revision strengthened the plumbing underneath them, not the goals themselves. See `19-architecture-audit-and-readiness.md` for the full list of what changed and why.

## Purpose

This is the permanent AI content engine for Blogspage. It is a standalone automation project (`Blogspage Automations`) that researches, writes, reviews, illustrates, structures, and publishes blog posts directly into the `Blogspage Agency` Sanity dataset via the Content Lake API. It never touches Blogspage Agency's source code — the only integration surface is Sanity documents (see `knowledge/automation-integration.md`).

## Design goals (non-negotiable)

| Goal | What it means concretely |
|---|---|
| Modular | Every pipeline step is an independently invocable, independently testable unit with one job. No step reaches into another step's internals. |
| Production-ready | Structured logging, typed errors, retries with backoff, idempotent writes, no silent failures. |
| Scalable | Stateless modules + a persisted run envelope mean the pipeline can run one post at a time or fan out across many topics concurrently without shared mutable state. |
| Reusable | Modules are plain functions/classes with a single JSON-in/JSON-out contract. Any module can be lifted into a different pipeline (e.g. a future newsletter generator) without modification. |
| Testable | Every module can be unit-tested with a fixture envelope and a mocked provider client. No module requires a live LLM call or live Sanity connection to test its logic. |
| Cost-optimized | Cheap models for mechanical steps, premium models only where reasoning quality matters; caching, batching, and parallelism applied wherever the pipeline shape allows. |
| Provider-agnostic | Every module that calls an LLM does so through a `LLMProvider` interface. Swapping OpenAI ↔ Anthropic ↔ Gemini ↔ OpenRouter ↔ a local model changes one config value, not module code. |

## What this system produces

One fully-formed Sanity `post` document per run, satisfying every rule in `knowledge/automation-integration.md`:
- Valid Portable Text `content` (never Markdown/HTML)
- `excerpt` 50–200 chars (hard schema requirement)
- Uploaded image assets (never fabricated `asset._ref`)
- Self-checked slug uniqueness
- SEO fields populated so the site's own render-time JSON-LD builders produce full structured data (the automation does not author JSON-LD itself — see the reconciliation note below)
- Optional FAQ items, internal links, categories, author reference

## High-level flow

```
Sheet row (topic brief)
        │
        ▼
┌───────────────────┐
│  INGEST            │  Config load → Sheets read → row validation
└─────────┬──────────┘
          ▼
┌───────────────────┐
│  RESEARCH & PLAN   │  Research → Content Plan → SEO Plan
└─────────┬──────────┘
          ▼
┌───────────────────┐
│  DRAFT             │  Article Writer (produces internal Markdown+AST draft)
└─────────┬──────────┘
          ▼
┌───────────────────┐
│  REVIEW LOOP       │  Technical Review ⇄ SEO Review ⇄ Humanize ⇄ Improve
│                    │  (bounded iteration, gated by Technical QA)
└─────────┬──────────┘
          ▼
┌───────────────────┐
│  MEDIA             │  Image Plan → Image Generate → Image Validate →
│                    │  Image Upload (to Sanity assets)  (bounded retry loop)
└─────────┬──────────┘
          ▼
┌───────────────────┐
│  STRUCTURE         │  Portable Text Convert (embeds real Sanity image
│                    │  refs) → Internal Links → FAQ → Structured-Data
│                    │  Readiness Check
└─────────┬──────────┘
          ▼
┌───────────────────┐
│  PUBLISH           │  Sanity Document Build+Validate → Publish
│                    │  (slug/uniqueness-safe transaction)
└─────────┬──────────┘
          ▼
┌───────────────────┐
│  NOTIFY & OBSERVE  │  Slack/Email notification, structured logs, metrics
└────────────────────┘
```

Every box is one or more modules (full list and per-module spec in `03-module-flow.md`). The pipeline is **linear with two bounded revision loops** (review loop, image validation loop) — never open-ended recursion. Both loops have a hard `maxIterations` and fail closed (route to human review, never publish silently-degraded content).

## The single data contract: `PipelineState`

Every module receives the same JSON envelope, reads the keys it needs, and returns the same envelope with exactly one new top-level key appended (its own namespaced output). No module ever mutates another module's section. This is what makes "zero transformation between modules" true by construction — see `04-json-contracts.md` for the full schema. The orchestrator persists `PipelineState` after every module completes, so any run can resume from its last successful step after a crash or a killed process.

## Reconciling the requested module list against the real target system

The user's requested module list includes a **JSON-LD Generator**. Ground truth from `knowledge/seo-system.md` and `knowledge/automation-integration.md`: Blogspage Agency generates all three JSON-LD types (`BlogPosting`, `BreadcrumbList`, `FAQPage`) **at render time**, from document fields, via `src/lib/blog.ts`. The automation does not need to — and must not — author JSON-LD directly; doing so would create a second, driftable source of structured data that the site never reads.

Decision: module 17 is renamed **Structured-Data Readiness Validator**. Its job is not to *generate* JSON-LD but to verify that every field the site's JSON-LD builders depend on (`excerpt`/`metaDescription`, `mainImage`+`alt`, `author.jobTitle`/`sameAs`, `categories`, `seoKeywords`, `faq`) is populated to spec, so that the structured data Blogspage renders is complete. This preserves the user's module list in spirit (structured-data quality is still checked) while staying correct about which system owns JSON-LD authorship. This is flagged explicitly here because it's the one place this architecture deviates from a literal reading of the request.

## What this system is not

- Not a CMS. It has no UI; it is a scheduled/triggered pipeline (cron, manual invoke, or queue-driven).
- Not a modification of Blogspage Agency. Zero files in that repo are touched, per the read-only contract in `knowledge/`.
- Not a general-purpose agent. Each module is a narrow, deterministic-as-possible function around one LLM call (or one deterministic transform); there is no open-ended "agent decides what to do next" loop anywhere in the critical path.

## Cross-cutting concerns (apply to every module, detailed in their own docs)

- **Provider abstraction** (`09-provider-abstraction.md`): all LLM calls go through one interface.
- **Prompts as files** (`05-prompt-strategy.md`): no prompt text lives in module code.
- **Cost control** (`06-cost-optimization.md`): model tier is a per-module config value, not hardcoded.
- **Error handling & retries** (`07-error-handling.md`, `08-retry-strategy.md`): every module fails predictably and recovers predictably.
- **Testing** (`10-testing-strategy.md`): every module has a unit test with a fixture, and the whole pipeline has an integration test against a Sanity sandbox dataset.
- **Performance** (`11-performance.md`): where the pipeline can parallelize (independent research queries, independent image generations) it does.

## Document map

| Doc | Answers |
|---|---|
| `02-folder-structure.md` | Where does every file live? (revised: registry-key naming, `storage/`/`logs/`/`output/`/`scripts/`/`reporting/`) |
| `03-module-flow.md` | What does each module do, module by module? (revised: registry keys, nested state paths, Cost Reporter) |
| `04-json-contracts.md` | Exact JSON shape in/out of every module (revised: nested `PipelineState`, ownership table, draft history) |
| `05-prompt-strategy.md` | Superseded pointer — see `13-prompt-management-system.md` |
| `06-cost-optimization.md` | Where money is spent and how it's minimized |
| `07-error-handling.md` | What happens when a module fails |
| `08-retry-strategy.md` | How retries are decided and bounded |
| `09-provider-abstraction.md` | How OpenAI/Anthropic/Gemini/OpenRouter/local are swapped (revised: cache/cost fields) |
| `10-testing-strategy.md` | How every layer is tested |
| `11-performance.md` | Latency and throughput design |
| `12-future-roadmap.md` | Build order, one module at a time, and what comes after v1 (revised build order) |
| `13-prompt-management-system.md` | The full Prompt Registry design — loading, versioning, inheritance, localization |
| `14-core-utilities.md` | The reusable, provider-independent utility layer |
| `15-cost-tracking-system.md` | The `CostEvent` schema and the Cost Reporter |
| `16-developer-workflow-playground.md` | Module Playground and Prompt Playground — low-cost local iteration |
| `17-module-dependency-diagram.md` | The real dependency graph (Mermaid), parallel vs. sequential vs. independent |
| `18-scalability-and-future-features.md` | What future features this architecture already absorbs, and what it honestly doesn't |
| `19-architecture-audit-and-readiness.md` | Final audit, readiness score, and implementation go/no-go |
| `20-product-reselling-architecture.md` | Client profiles, per-client configuration, image-strategy options, resale economics |
| `21-cost-budget-modes-human-in-loop.md` | Hard cost budgets ($0.10/article), run-set profiles, manual checkpoints |
