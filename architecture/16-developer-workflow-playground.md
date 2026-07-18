# 16 — Developer Workflow & Playground

## The problem this solves

Every module in this pipeline eventually calls a real LLM or image provider. Without a way to run one module in isolation, the only way to iterate on a prompt or a module's logic is to run the entire orchestrator end-to-end — paying for every upstream module's calls just to reach the one line you're actually changing. At 21 modules and real per-call cost (`06-cost-optimization.md`, `15-cost-tracking-system.md`), that's not just slow, it's a direct tax on iteration speed and therefore on architecture quality itself: a developer who has to spend $0.40 and wait two minutes to test a one-line prompt tweak will iterate less, and the system will improve more slowly. This document designs the two commands that remove that tax: **Module Playground** and **Prompt Playground**.

## Module Playground — `npm run module <key>`

Runs exactly one module, standalone, against a fixture `PipelineState` slice, with real provider calls (unless `--dry-run` is passed — see below).

```
npm run module writer
npm run module reviewer-technical
npm run module image-planner
npm run module image-generator
```

### What it does, step by step

1. Resolves `<key>` against the same registry-key vocabulary used everywhere else in this architecture (`13-prompt-management-system.md`'s prompt folders, `15-cost-tracking-system.md`'s `moduleKey`, and `03-module-flow.md`'s module folders — one name, one lookup, no per-tool translation table to maintain).
2. Loads a fixture `PipelineState` from `src/modules/<key>/__tests__/fixtures/` — the **same fixture files** the module's own unit test (`10-testing-strategy.md`) already uses. This is deliberate, not a convenience: it means the playground and the test suite can never silently drift into testing against different inputs, and adding a new fixture for a tricky edge case benefits both the automated test and manual playground exploration for free.
3. Instantiates the module's real dependencies via the real `providerFactory`/`imageProviderFactory` (`09-provider-abstraction.md`) — this is intentionally the real provider, not the `FakeLLMProvider` used in unit tests, because the playground's whole purpose is to let a developer see real model output, which a fake provider by definition cannot show.
4. Runs the module, prints the resulting output slice (the one key it wrote, per `04-json-contracts.md`'s one-module-one-key rule) as formatted JSON to stdout.
5. Emits a `CostEvent` (`15-cost-tracking-system.md`) tagged with `runId: 'playground-<timestamp>'` so playground usage shows up in cost reporting distinctly from real pipeline runs — a developer iterating heavily on a prompt should be able to see "how much did my afternoon of prompt tuning cost," and that number should never be confused with or hidden inside production run costs.

### Flags

| Flag | Effect |
|---|---|
| `--fixture=<name>` | Use a specific named fixture instead of the module's default (e.g. `--fixture=short-brief` vs. `--fixture=long-technical-brief`) — every module's fixtures directory can hold more than one case. |
| `--tier=<CHEAP\|STANDARD\|PREMIUM>` | Override the module's configured tier for this one playground run — lets a developer cheaply sanity-check "does this prompt even work at all" on the cheap tier before spending premium-tier budget confirming quality. |
| `--dry-run` | Skips the real provider call entirely; prints the fully-assembled prompt (system + user, after registry resolution and interpolation) instead of calling anything. Zero cost. This is the bridge to Prompt Playground below — in practice, a developer reaches for `--dry-run` first, then drops it once the prompt looks right. |
| `--save-fixture=<name>` | Writes the module's real output for this run back as a new fixture file — the concrete mechanism for growing the fixture library from real observed model behavior rather than only hand-written fixtures. |

### What it deliberately does not do

It does not run the orchestrator, does not touch `stateStore`, does not write to Sanity, does not send a Notification. It is a pure, isolated, single-module invocation — the moment a developer needs to see how a module's output flows into the *next* module, that's what the sandbox integration test (`10-testing-strategy.md`) is for, not this tool. Keeping Module Playground single-module-only is what keeps it fast and cheap; blurring that line would recreate the exact "have to run everything to test one thing" problem this tool exists to solve.

## Prompt Playground — `npm run prompt <key>`

A lighter-weight sibling to Module Playground, focused purely on prompt iteration with the fastest possible feedback loop and the lowest possible cost:

```
npm run prompt writer
npm run prompt qa --var focusKeyword="direct booking hotel"
```

### What it does differently from Module Playground

- **Skips module logic entirely** — no `validate.ts`, no schema enforcement, no error-class wrapping. It calls `promptRegistry.get(key, vars)` (`13-prompt-management-system.md`) directly, sends the resulting `PromptSet` straight to the configured provider via `LLMProvider.complete()`, and prints the raw response text. This is intentionally *less* correct than a real module invocation — the point is speed of seeing "what does the model say when given this exact prompt," not validating the full pipeline contract.
- **Defaults to `CHEAP` tier** regardless of the module's real configured tier, specifically to minimize cost during the highest-iteration-frequency activity in the whole system (per the refinement request's own framing: "minimize API cost during development"). A `--tier=PREMIUM` override exists for the final confirmation pass once wording is settled, but is never the default.
- **`--var key=value`** flags let a developer override individual `vars` values interactively without editing a fixture file — the fastest possible "change one variable, see the effect" loop, useful for testing prompt sensitivity to a specific input (e.g. "does the writer prompt still respect word count if I set `targetWordCount` to an unusually low value").
- **Prints the resolved prompt alongside the response** by default (not just the response) — the developer should always be able to see exactly what was sent, including which shared fragments got included and which `{{variable}}` placeholders resolved to what, since a prompt bug is very often "the wrong thing got interpolated," which is invisible if only the model's output is shown.

### Loop this enables

```
1. Edit src/prompts/writer/user.md
2. npm run prompt writer            → see real (cheap-tier) output in ~2-5s, ~$0.001
3. Not right? Edit again, repeat 2
4. Good? npm run prompt writer --tier=PREMIUM   → confirm at real tier, still isolated from full module logic
5. Good? npm run module writer                   → confirm the FULL module (schema validation, error handling) still passes
6. Good? npm test src/modules/writer              → confirm the unit test suite still passes (may need fixture updates)
```

Each step is strictly more expensive/slower than the last and is only reached once the previous step passed — this ordering is the actual point of building two separate playground tools instead of one: cost and iteration speed should scale with how much confidence the previous step already gave the developer, not be paid up front on every edit.

## Where these tools live and what they depend on

```
src/cli/
├── run.ts                  # the real pipeline entrypoint (02-folder-structure.md, unchanged)
├── modulePlayground.ts      # npm run module <key>
└── promptPlayground.ts      # npm run prompt <key>
```

Both playground tools depend on the same `providerFactory`, `promptRegistry`, and `stateStore`-adjacent fixture-loading helpers that real modules and real tests use — they introduce **zero new abstractions**, they are thin CLI wrappers around infrastructure this architecture already specifies elsewhere (`09-provider-abstraction.md`, `13-prompt-management-system.md`, `10-testing-strategy.md`'s fixtures). This is a deliberate constraint: a developer-experience tool that requires its own parallel plumbing is a maintenance burden that will drift from the real system it's supposed to be a fast mirror of.

## `package.json` script wiring (illustrative, not implementation)

```json
{
  "scripts": {
    "module": "tsx src/cli/modulePlayground.ts",
    "prompt": "tsx src/cli/promptPlayground.ts"
  }
}
```

Documented here only to make the two commands' existence concrete and unambiguous for the eventual implementer — this is configuration, not production code, and stays purely descriptive per this phase's constraint against writing implementation.
