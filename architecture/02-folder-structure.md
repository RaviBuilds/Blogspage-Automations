# 02 — Folder Structure (revised)

> **Revision note:** The original folder structure was correct in its principles (module isolation, prompts-as-files, provider isolation) but under-specified three things the refinement pass surfaced: a dedicated `reporting/` layer for the Cost Reporter (`15-cost-tracking-system.md`), a clean separation of `storage/` (state + cost logs), `logs/` (structured run logs), and `output/` (any locally-written artifacts, e.g. playground `--save-fixture` output) which the original structure conflated under implicit "somewhere," and a rename of every module/prompt folder to the registry-key vocabulary established in `13-prompt-management-system.md`. This revision folds all three in. The **principles** below are unchanged from the original document — only the concrete tree and the naming convention changed.

## Principles (unchanged, one correction)

- One module = one folder under `src/modules/`. A module folder never imports from another module's folder directly — only from `src/core/`, `src/providers/`, `src/integrations/`, or `src/lib/`. *(Corrected in this revision — the original principle omitted `src/integrations/`, even though `03-module-flow.md` always documented modules like Sheet Reader, SEO Planner, Internal Link Generator, Image Upload, Sanity Document Builder, and Publish as depending directly on `SheetsClient`/`sanityReadClient`/`sanityWriteClient`. The rule text and the actual module dependencies had drifted apart; this is a documentation-consistency fix, not a design change — see `19-architecture-audit-and-readiness.md` for how this was found.)*
- Prompts are never inline strings in `.ts` files — every prompt lives under `src/prompts/` as its own Markdown file (`13-prompt-management-system.md`).
- Everything that talks to an external system (Sheets, an LLM provider, an image-gen provider, Sanity, Slack/Email) is isolated behind an adapter in `src/providers/` or `src/integrations/`.
- Config is centralized and typed; no module reads `process.env` directly.
- **New in this revision:** every module folder's name, every prompt folder's name, every `CostEvent.moduleKey` value, and every `npm run module <key>` / `npm run prompt <key>` argument are the *same string* — the registry key. One name, looked up the same way everywhere, is what makes `13-prompt-management-system.md`'s Prompt Registry, `15-cost-tracking-system.md`'s Cost Reporter, and `16-developer-workflow-playground.md`'s CLI tools cross-reference each other without a translation table anywhere.

## Registry-key naming table (the renames from the original structure)

| Original folder name | Registry key (new folder name) |
|---|---|
| `01-sheet-reader` | `sheet-reader` |
| `02-research` | `research` |
| `03-content-planner` | `planner` |
| `04-seo-planner` | `seo-planner` |
| `05-article-writer` | `writer` |
| `06-technical-reviewer` | `reviewer-technical` |
| `07-seo-reviewer` | `reviewer-seo` |
| `08-humanizer` | `humanizer` |
| `09-technical-qa` | `qa` |
| `10-article-improver` | `improver` |
| `11-image-planner` | `image-planner` |
| `12-image-generator` | `image-generator` |
| `13-image-validator` | `image-validator` |
| `14-portable-text-converter` | `portable-text` |
| `15-internal-link-generator` | `internal-links` |
| `16-faq-generator` | `faq-generator` |
| `17-structured-data-validator` | `structured-data-check` |
| `18-image-upload` | `image-upload` |
| `19-sanity-upload` | `sanity-builder` *(renamed to match its actual role — module 19 builds the document; module 20 does the upload/publish — the original name conflated the two, see note below)* |
| `20-publish` | `publish` |
| `21-notification` | `notify` |

**Naming correction alongside the rename:** the original structure named module 19's folder `19-sanity-upload`, but `03-module-flow.md` describes module 19 as "Sanity Document Builder" (assembly, no network call) and module 20 as "Publish" (the actual write). `19-sanity-upload` was a misleading name for a module that performs no upload — corrected to `sanity-builder` as part of this same pass, since it was already being touched for the registry-key rename and leaving a known-wrong name in place would be worse than fixing it here.

The leading numeric prefixes (`01-`, `02-`, …) are dropped entirely — they implied a fixed execution order that `03-module-flow.md` itself documents *isn't* strictly numeric (Internal Link Generator runs before Portable Text Converter despite being numbered after it). The orchestrator's execution order (`core/orchestrator.ts`, and now formally `17-module-dependency-diagram.md`'s dependency graph) is the only correct source for sequence; folder names should not imply one.

## Top-level layout (revised)

```
Blogspage Automations/
├── architecture/                   # this documentation set (already exists)
├── knowledge/                      # ground-truth facts about Blogspage Agency (already exists)
├── .claude/                        # skills (already exists)
├── src/
│   ├── config/
│   │   ├── env.ts
│   │   ├── models.ts
│   │   ├── pipeline.ts
│   │   └── profiles.ts            # NEW — Client Profile types + budget presets (20-product-reselling-architecture.md)
│   │
│   ├── core/
│   │   ├── types.ts                # PipelineState + per-section types (source of truth for 04-json-contracts.md)
│   │   ├── orchestrator.ts
│   │   ├── moduleRunner.ts
│   │   ├── errors.ts
│   │   └── stateStore.ts           # NOW writes into storage/state/ — see storage/ below, not an implicit local path
│   │
│   ├── providers/
│   │   ├── shared/
│   │   │   └── ProviderStatus.ts   # NEW (09-provider-abstraction.md's Phase 4 pre-implementation revision) —
│   │   │                            # the ProviderStatus/ProviderHealthReporter interfaces, shared by both
│   │   │                            # llm/ and image/ adapters. Interface only; no orchestration logic here.
│   │   ├── llm/
│   │   │   ├── LLMProvider.ts
│   │   │   ├── AnthropicProvider.ts
│   │   │   ├── OpenAIProvider.ts
│   │   │   ├── GeminiProvider.ts
│   │   │   ├── OpenRouterProvider.ts
│   │   │   ├── LocalLLMProvider.ts
│   │   │   └── providerFactory.ts
│   │   └── image/
│   │       ├── ImageProvider.ts
│   │       ├── OpenAIImageProvider.ts
│   │       ├── GeminiImageProvider.ts
│   │       └── imageProviderFactory.ts
│   │
│   ├── integrations/
│   │   ├── sheets/SheetsClient.ts
│   │   ├── sanity/
│   │   │   ├── sanityWriteClient.ts
│   │   │   ├── sanityReadClient.ts
│   │   │   └── seedRefs.ts
│   │   └── notify/
│   │       ├── SlackNotifier.ts
│   │       └── EmailNotifier.ts
│   │
│   ├── modules/                    # every folder name is now a bare registry key — see table above
│   │   ├── sheet-reader/
│   │   ├── research/
│   │   ├── planner/
│   │   ├── seo-planner/
│   │   ├── writer/
│   │   ├── reviewer-technical/
│   │   ├── reviewer-seo/
│   │   ├── humanizer/
│   │   ├── qa/
│   │   ├── improver/
│   │   ├── image-planner/
│   │   ├── image-generator/
│   │   ├── image-validator/
│   │   ├── portable-text/
│   │   ├── internal-links/
│   │   ├── faq-generator/
│   │   ├── structured-data-check/
│   │   ├── image-upload/
│   │   ├── sanity-builder/
│   │   ├── publish/
│   │   └── notify/
│   │       # each folder contains:
│   │       #   index.ts           — the module's run(state, ctx) function, thin orchestration only
│   │       #   validate.ts        — schema validation, built on lib/schemaValidator.ts (14-core-utilities.md)
│   │       #   README.md          — pointer back to 03-module-flow.md § this module and 04-json-contracts.md's ownership row
│   │       #   __tests__/
│   │       #       index.test.ts  — unit test with FakeLLMProvider + fixture input
│   │       #       fixtures/      — sample input/output JSON; ALSO the fixtures Module Playground reads (16-developer-workflow-playground.md)
│   │
│   ├── prompts/                    # every folder name is the same registry key as its module — see 13-prompt-management-system.md
│   │   ├── shared/                 # renamed from _shared/ — naming-consistency fix, see 13-prompt-management-system.md
│   │   │   ├── brand-voice.md
│   │   │   ├── output-format-json.md
│   │   │   └── json-schema-contract.md
│   │   ├── overrides/              # NEW, empty in v1 — tenant/locale override resolution root (13-prompt-management-system.md)
│   │   ├── research/{system,user,examples}.md
│   │   ├── planner/{system,user,examples}.md
│   │   ├── seo-planner/{system,user,examples}.md
│   │   ├── writer/{system,user,validation,examples}.md
│   │   ├── reviewer-technical/{system,user,validation}.md
│   │   ├── reviewer-seo/{system,user,validation}.md
│   │   ├── humanizer/{system,user}.md
│   │   ├── qa/{system,user,validation}.md
│   │   ├── improver/{system,user,repair}.md
│   │   ├── image-planner/{system,user}.md
│   │   ├── image-validator/{system,user,validation}.md
│   │   ├── internal-links/{system,user}.md
│   │   ├── faq-generator/{system,user}.md
│   │   └── registry.ts             # NEW — the Prompt Registry implementation (13-prompt-management-system.md)
│   │
│   ├── lib/                        # full inventory now documented in 14-core-utilities.md — this tree reflects it
│   │   ├── portableText/
│   │   │   ├── fromMarkdownAst.ts
│   │   │   └── validatePortableText.ts
│   │   ├── slug.ts
│   │   ├── filename.ts             # NEW — 14-core-utilities.md
│   │   ├── readingTime.ts          # NEW
│   │   ├── markdown.ts             # NEW
│   │   ├── json.ts
│   │   ├── schemaValidator.ts      # NEW
│   │   ├── dates.ts                # NEW
│   │   ├── tokenCount.ts
│   │   ├── fileHelpers.ts          # NEW
│   │   ├── imageHelpers.ts         # NEW
│   │   ├── retry.ts                # NEW — pure backoff-math, used by core/moduleRunner.ts
│   │   ├── cache.ts                # NEW — generic TTL cache, used by prompts.ts and the existing-posts-list cache
│   │   └── prompts.ts              # loading/partial-resolution/interpolation mechanics underneath prompts/registry.ts
│   │
│   ├── reporting/                  # NEW — 15-cost-tracking-system.md
│   │   └── costReporter.ts         # pure CostEvent[] → report transformation; no provider/DB dependency
│   │
│   ├── logging/
│   │   ├── logger.ts               # writes structured lines into logs/ (below), never to storage/
│   │   └── metrics.ts
│   │
│   └── cli/
│       ├── run.ts                  # the real pipeline entrypoint: `run.ts --sheet-row=<n>` or `--all-pending`
│       ├── modulePlayground.ts     # NEW — `npm run module <key>` (16-developer-workflow-playground.md)
│       └── promptPlayground.ts     # NEW — `npm run prompt <key>`
│
├── storage/                        # NEW, top-level — durable pipeline state and cost history, never committed to git
│   ├── state/                      # core/stateStore.ts's PipelineState snapshots, one per runId
│   ├── costs/                      # 15-cost-tracking-system.md's append-only CostEvent .jsonl logs, one file per day
│   └── staging/                    # NEW — human-in-the-loop image handoff (21-cost-budget-modes-human-in-loop.md): one dir per runId, written by attach-images
│
├── logs/                           # NEW, top-level — structured run logs (07-error-handling.md's logging discipline), never committed
│
├── output/                         # NEW, top-level — locally-written artifacts: Module Playground's --save-fixture writes,
│                                    #   any ad hoc local debugging output. Never read by the real pipeline — write-only scratch space.
│
├── scripts/                        # NEW, top-level — one-off/maintenance scripts, mirroring the pattern already established
│   │                                #   in Blogspage Agency itself (knowledge/utilities.md: seed-meta.ts, migrate.ts, etc.)
│   └── setupSandboxDataset.ts      # e.g. provisions the Sanity sandbox dataset used by tests/integration/
│
├── tests/
│   ├── integration/
│   │   └── fullPipeline.sandbox.test.ts
│   ├── contract/                   # NEW — module-to-module PipelineState contract tests (10-testing-strategy.md)
│   │   └── moduleChain.test.ts
│   └── fixtures/
│       └── pipelineState.sample.json   # a full valid PipelineState (revised nested shape, 04-json-contracts.md)
│
├── .env.example
├── package.json
└── tsconfig.json
```

## Why each top-level addition exists

- **`storage/`** — the original design left `core/stateStore.ts`'s persistence location implicit ("local JSON file in v1"). Making it an explicit top-level folder, split into `state/` and `costs/`, does two things: it gives `.gitignore` one clear target (durable run data must never be committed — it can contain full article drafts and, transitively, cost/usage data), and it matches the "storage" name the refinement request itself used in its folder-separation list, rather than leaving this as an implementation detail buried inside `core/`.
- **`logs/`** — separated from `storage/` because logs and state have different retention/rotation needs (logs are for humans debugging a recent run; `storage/state/` is for the orchestrator's own crash-resume logic and cost history). Conflating them would mean a log-rotation policy accidentally deleting resumable run state, or a state-retention policy keeping years of verbose logs around unnecessarily.
- **`output/`** — exists specifically because `16-developer-workflow-playground.md`'s `--save-fixture` flag needs somewhere to write that isn't `src/modules/<key>/__tests__/fixtures/` directly (a developer should review and deliberately move a playground output into the real fixtures folder, not have it land there automatically) — this folder is the deliberate, reviewable staging area for that.
- **`scripts/`** — one-off/maintenance scripts (sandbox dataset setup, future data-migration scripts) belong outside `src/` because, per `knowledge/utilities.md`'s own documented pattern for Blogspage Agency, these are excluded from the main type-checked/tested build scope and load their own env — mixing them into `src/` would blur that boundary the target system itself already draws correctly.
- **`tests/contract/`** — promoted from an implied "a contract-test suite exists" in the original `10-testing-strategy.md` prose to an explicit folder, since `04-json-contracts.md`'s revised ownership table now gives contract tests a precise, enumerable list of boundaries to cover (one per row in that table).

## Why this shape (remaining points, unchanged from the original document)

- **`providers/llm/` and `providers/image/`** remain the only two places a provider SDK import may appear anywhere in the codebase.
- **`integrations/sanity/`** remains the only place `@sanity/client` is imported.
- **`core/types.ts`** remains the single source of truth for `PipelineState`'s TypeScript shape — `04-json-contracts.md` (revised) documents it in prose; this file is where it's actually declared.
- **`prompts/` mirrors `modules/`** one-to-one by registry key, now including the `overrides/` and `shared/` siblings `13-prompt-management-system.md` specifies, and the `registry.ts` file that is the concrete Prompt Registry implementation module code depends on.
