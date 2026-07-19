# 13 — Prompt Management System

This document supersedes the folder-shape details in `05-prompt-strategy.md` (that file's *principles* — no inline prompts, four-file pattern, shared fragments — still hold; this file makes the structure concrete, adds the file type that was missing (`examples.md`), and introduces the **Prompt Registry**, the abstraction that lets modules load prompts without knowing file paths).

## Why this needs its own document

At 21 modules and one prompt-per-role file, this system already has ~60+ prompt files. At commercial scale (more modules, more brands, more languages — see `18-scalability-and-future-features.md`), that number grows into the hundreds. "Read the file at a hardcoded relative path" (what `05-prompt-strategy.md` originally specified) does not survive that growth — a rename, a per-brand override, or a locale variant all become path-computation logic bleeding into every module. The fix is the same one this architecture already applies to LLM providers: **put an interface between the consumer and the concrete resource.** For prompts, that interface is the **Prompt Registry**.

## Folder structure (final)

```
src/prompts/
├── shared/
│   ├── brand-voice.md              # renamed from _shared/ — "shared" is the noun this project already
│   ├── output-format-json.md       #   uses everywhere else (shared fragments, shared types); _shared/
│   └── json-schema-contract.md     #   read like a hidden file and was the one inconsistent name in the tree
│
├── research/
│   ├── system.md
│   ├── user.md
│   └── examples.md                 # NEW file type — few-shot examples, kept separate from user.md (see below)
├── planner/                        # renamed from content-planner/ — matches module registry key, see naming note
│   ├── system.md
│   ├── user.md
│   └── examples.md
├── seo-planner/
│   ├── system.md
│   ├── user.md
│   └── examples.md
├── writer/                         # renamed from article-writer/ — shorter registry key, see naming note
│   ├── system.md
│   ├── user.md
│   ├── validation.md
│   └── examples.md
├── reviewer-technical/             # renamed from technical-reviewer/ — see naming note
│   ├── system.md
│   ├── user.md
│   └── validation.md
├── reviewer-seo/                   # renamed from seo-reviewer/
│   ├── system.md
│   ├── user.md
│   └── validation.md
├── humanizer/
│   ├── system.md
│   └── user.md
├── qa/                             # renamed from technical-qa/ — matches module registry key
│   ├── system.md
│   ├── user.md
│   └── validation.md
├── improver/                       # renamed from article-improver/
│   ├── system.md
│   ├── user.md
│   └── repair.md
├── image-planner/
│   ├── system.md
│   └── user.md
├── image-validator/
│   ├── system.md
│   ├── user.md
│   └── validation.md
├── internal-links/
│   ├── system.md
│   └── user.md
└── faq-generator/
    ├── system.md
    └── user.md
```

**Naming note:** module-folder names in `src/prompts/` are renamed to match the *registry key* each module is looked up by (`writer`, `planner`, `qa`, `reviewer-technical`, `reviewer-seo`, `improver`), not the longer descriptive names used in `03-module-flow.md`'s prose. This removes a translation step that existed in the original design (code said `article-writer`, folder said `05-article-writer`, prompt folder said `article-writer` — three names for one concept, only accidentally consistent). Registry key is now the single name used everywhere: module folder, prompt folder, log lines, cost reports, and the `npm run module <key>` / `npm run prompt <key>` commands in `16-developer-workflow-playground.md`. `02-folder-structure.md` is updated to match.

## The five file roles (was four — `examples.md` added)

| File | Role | Injected as |
|---|---|---|
| `system.md` | Model role, constraints, output-format contract. | The `system` field on the provider call. |
| `user.md` | The per-invocation task template, filled from `PipelineState`. | The `user` message. |
| `examples.md` | Few-shot input/output pairs, kept **separate from `user.md`** (not appended inline) so examples can be swapped, trimmed, or A/B'd (`12-future-roadmap.md`'s deferred prompt-variants feature) without editing the task template itself. | Injected into `user.md` at a `{{examples}}` placeholder, or omitted entirely for modules where few-shot doesn't help (Humanizer, Internal Link Generator). |
| `validation.md` | The rubric text for review-type modules. | Injected into `user.md` at a `{{rubric}}` placeholder — same mechanism as `05-prompt-strategy.md` originally specified. |
| `repair.md` | The "make the smallest edit" instruction for Article Improver. | Injected into `user.md` at a `{{repairInstructions}}` placeholder. |

Why `examples.md` is new: the original design had no place for few-shot examples except inline in `user.md`, which meant every example edit was a task-template edit. Separating them is the same reasoning that already justified splitting `validation.md` out of `user.md` — different churn rate, different owner (a content lead tunes examples; an engineer tunes the task template), should be a different file.

## The Prompt Registry

**Modules never construct a file path.** They ask the registry for a named prompt set by registry key:

```ts
// src/prompts/registry.ts
interface PromptSet {
  system: string;
  user: string;
  examples?: string;
  validation?: string;
  repair?: string;
}

interface PromptRegistry {
  get(key: PromptKey, vars: Record<string, string>): Promise<PromptSet>;
}

// module code — this is the ENTIRE prompt-loading surface a module ever touches
const prompts = await promptRegistry.get('writer', {
  angle: state.planning.angle,
  targetWordCount: String(state.planning.targetWordCount),
  outlineAsMarkdownList: renderOutline(state.planning.outline),
});
const result = await provider.complete({ systemPrompt: prompts.system, userPrompt: prompts.user, ... });
```

`PromptKey` is a string-literal union (`'research' | 'planner' | 'writer' | ...`) generated from the actual folder names under `src/prompts/`, so a typo in a registry key is a compile-time error, not a runtime file-not-found. The registry's job:

1. Resolve `key` → the correct folder, applying **inheritance/override rules** (next section) — this is the part a module must never do itself, because the resolution rule changes over time (adding brand overrides, adding locale variants) without any module code changing.
2. Load and cache the raw files (`10-testing-strategy.md`'s snapshot-test layer sits on top of this cache).
3. Resolve `{{> shared/brand-voice.md}}`-style partial includes inside `system.md`/`user.md`.
4. Interpolate `{{variable}}` placeholders from `vars`, throwing loudly on any unresolved placeholder (unchanged from `05-prompt-strategy.md`'s rule — repeated here because it remains correct, not because it changed).
5. Return the assembled `PromptSet`.

This is the same interface-in-front-of-a-concrete-resource pattern as `LLMProvider` (`09-provider-abstraction.md`) — a module depends on `PromptRegistry`, never on `fs.readFile` or a path string, for exactly the same swap-without-code-change reason.

## Prompt loading (mechanics)

```
promptRegistry.get('writer', vars)
  │
  ├─ resolvePath('writer')             → applies inheritance (below) → concrete folder
  ├─ readCached('writer/system.md')    → raw text, process-lifetime cache (05-prompt-strategy.md's rule, unchanged)
  ├─ resolvePartials(raw)              → expands {{> shared/*.md}} includes
  ├─ interpolate(withPartials, vars)   → fills {{variable}} placeholders, throws on any miss
  └─ returns { system, user, examples?, validation?, repair? }
```

Loading is `async` even though the v1 implementation is a local file read, specifically so the registry's *interface* doesn't have to change when prompts eventually move to a remote store (a CMS-managed prompt table, for multi-tenant per-brand overrides — see `18-scalability-and-future-features.md`). A sync file read baked into the interface would make that migration a breaking change to every module; an async interface makes it an internal registry-implementation change, invisible to callers.

## Prompt versioning

Two distinct versioning needs exist and are handled differently:

1. **Git history is the version history for prompt *content*.** A prompt file change is a normal commit, same as `05-prompt-strategy.md` already established — no separate versioning database for v1. `git blame`/`git log` on a prompt file answers "what changed and when" completely, for free.
2. **A prompt *version tag* is recorded per LLM call, for reproducibility of a specific run's output.** Every `PromptSet` returned by the registry carries a `promptVersion` field, formally defined as **the current repository HEAD short commit hash** (computed via `git rev-parse --short HEAD`, cached for the process lifetime, not re-computed per call). This is a repository-wide value, not a per-prompt-folder value: every registry key resolves to the same `promptVersion` at a given point in time, because it reflects the state of the whole repository at that commit, not specifically the last commit that touched one prompt's folder. (An earlier draft of this document described `promptVersion` as computed via `git rev-parse --short HEAD -- src/prompts/<key>/`, i.e. scoped to one prompt folder — this was corrected after implementation confirmed that passing a pathspec to `git rev-parse --short HEAD` does not change its output; the command always resolves to the repository's current `HEAD`, regardless of path.) This value is written into `state.metrics` per module call (see `15-cost-tracking-system.md`) so that, months later, "which overall repository commit produced this specific published article" is an answerable question without needing a database — it's a join between the run's logged `promptVersion` and `git log`. Isolating which specific prompt file changed within that commit still requires a separate `git log -- src/prompts/<key>/` lookup; `promptVersion` alone does not distinguish "this prompt folder changed" from "an unrelated file elsewhere in the repository changed."

This is deliberately lightweight: no prompt-versioning service, no semantic version numbers to maintain by hand, no risk of the version tag drifting from the actual file content, because it's derived from git, not hand-incremented.

## Prompt inheritance

This is the mechanism that lets a future brand, locale, or A/B variant override one file in a prompt set without duplicating the whole set. Resolution order, most-specific wins:

```
1. src/prompts/overrides/{tenantId}/{locale}/{key}/{file}   (most specific — a tenant+locale override)
2. src/prompts/overrides/{tenantId}/{key}/{file}            (a tenant override, any locale)
3. src/prompts/overrides/{locale}/{key}/{file}              (a locale override, any tenant)
4. src/prompts/{key}/{file}                                 (the base file — always exists)
```

Resolution is **per file, not per prompt set** — a tenant can override just `writer/system.md` (a different brand voice) while inheriting the base `writer/user.md`, `writer/examples.md` unchanged. This is why the registry resolves inheritance internally rather than a module picking a whole alternate folder: "override one file, inherit the rest" is exactly the behavior a module must not have to know how to implement.

**v1 has zero overrides** — `src/prompts/overrides/` doesn't need to exist yet, since there is one tenant (Blogspage) and one locale (English). The resolution chain is documented and built into the registry *now*, at negligible cost, specifically so that adding the first tenant override later is a new folder, not a rewrite of every module's prompt-loading call. This is the same "build the seam before you need it, because retrofitting a seam into working code is expensive" reasoning already used in `09-provider-abstraction.md`.

## Shared prompt fragments

Unchanged in principle from `05-prompt-strategy.md`, folder renamed `_shared/` → `shared/` (naming-consistency fix noted above). Two fragments exist at v1 (`brand-voice.md`, `output-format-json.md`); a third is added:

- **`shared/json-schema-contract.md`** — NEW. A fragment describing, generically, "how to return a JSON object matching a schema I'll show you" (formatting rules: no markdown fences, no leading/trailing prose, exact key names). Previously this instruction was duplicated with slight wording differences across `output-format-json.md` and ad hoc text inside several `user.md` files. Splitting the *generic JSON-output mechanics* (this fragment) from the *this-module's-specific-schema* content (which stays in each module's own `user.md`, since the schema itself is module-specific) removes that duplication.

Shared fragments are included via `{{> shared/brand-voice.md}}` inside a `system.md`/`user.md` file — the registry's partial-resolution step (above) is what expands this, so a shared-fragment edit propagates to every module that includes it on the next registry read, with zero module-code involvement.

## Output formatting & JSON enforcement

Layered, cheapest-and-most-reliable-mechanism-first:

1. **Provider-native structured output**, where the configured provider supports it (`LLMProvider.supportsJsonSchema`, from `09-provider-abstraction.md`) — the adapter passes the module's zod schema (converted to JSON Schema) directly to the provider's structured-output parameter. This is the strongest guarantee (the provider itself constrains generation) and should be preferred whenever the resolved provider for a given tier supports it.
2. **Prompt-level JSON-output contract** (`shared/output-format-json.md` + `shared/json-schema-contract.md`) — the fallback for providers/tiers where native structured output isn't available (e.g. a `LocalLLMProvider` pointed at a model without that feature). Instructs a specific plain-JSON-only format.
3. **`lib/json.ts`'s strict parse** (already specified in `02-folder-structure.md`) — strips any fence/prose the model added despite instruction 2, then validates against the module's zod schema. A parse or schema failure here is what raises the `ValidationError` that `08-retry-strategy.md`'s re-prompt-with-feedback path handles.

The registry doesn't own this layering — it owns making sure the right *prompt text* for the resolved provider's capability is what gets returned (a `PromptRegistry.get` call is capability-aware: if the resolved provider supports native structured output, the registry can omit the verbose JSON-formatting fragment from the assembled prompt entirely, saving the tokens that instruction would have cost — a direct, provider-capability-driven token reduction on top of the model-tiering savings in `06-cost-optimization.md`).

## Future localization support

Localization is **structurally the same mechanism as tenant overrides** (see "Prompt inheritance" above) — a locale is just another axis in the same resolution chain, already present in the chain's design even though v1 has no non-English content. What localization adds beyond the override mechanism itself:

- **`vars` gains a `locale` field**, threaded through by the orchestrator from `state.metadata.locale` (a field that exists in `04-json-contracts.md`'s revised schema even in v1, defaulted to `'en'`, precisely so adding a second locale later doesn't require adding a field to every module's input).
- **`examples.md` becomes locale-sensitive first**, in practice — a locale's tone/idiom is best taught via localized few-shot examples, while `system.md`'s structural instructions (word count discipline, output format) often translate directly. This is *why* examples were split into their own file in this document's design, not an afterthought: localization is one of the concrete reasons `examples.md` exists as a separate file from `user.md`.
- **No module code changes** — a module still calls `promptRegistry.get(key, vars)` with the same signature; `locale` flows through `vars`/the resolution chain, entirely inside the registry.

This is deferred work (`12-future-roadmap.md` already lists "multiple languages" as a post-v1 trigger-based feature), documented here only to confirm the registry's resolution-chain design doesn't need to change shape when that trigger arrives — it needs new *content* (translated prompt files), not new *architecture*.
