# 10 — Testing Strategy

## Testing pyramid for this system

```
        ┌─────────────────────────┐
        │  Sandbox integration     │  1 suite — full pipeline vs. a Sanity
        │  test (few, slow)         │  SANDBOX dataset, never production
        ├─────────────────────────┤
        │  Contract tests           │  PipelineState schema compatibility
        │  (module-to-module)       │  across every module boundary
        ├─────────────────────────┤
        │  Module unit tests        │  One per module, mocked provider,
        │  (many, fast)             │  fixture input/output
        └─────────────────────────┘
```

## Module unit tests

Every module folder (`src/modules/NN-name/__tests__/index.test.ts`) tests that module in complete isolation:

- **Provider calls are mocked**, never real, via a `FakeLLMProvider`/`FakeImageProvider` that implements the exact interfaces from `09-provider-abstraction.md` and returns a scripted `LLMCallResult` for the test case. This is possible with zero special-casing precisely because every module depends only on the provider *interface* — the same reason swapping real providers doesn't touch module code means swapping in a fake provider for tests doesn't either.
- **Input is a fixture** — a valid, minimal `PipelineState` slice containing exactly the keys that module's "Inputs" (per `03-module-flow.md`) declares, stored in `__tests__/fixtures/`.
- **Assertions check three things**: (1) the module's output matches its schema from `04-json-contracts.md`, (2) the module correctly calls its own `validate.ts` and rejects a fixture engineered to fail validation, (3) the module correctly classifies and surfaces the right error type (`07-error-handling.md`) when the fake provider is scripted to return an error.

```ts
// src/modules/05-article-writer/__tests__/index.test.ts (shape)
describe('Article Writer', () => {
  it('produces a Draft matching schema when the provider returns well-formed markdown', async () => {
    const fakeProvider = new FakeLLMProvider({ text: FIXTURE_MARKDOWN_RESPONSE, usage: {...} });
    const result = await runArticleWriter(FIXTURE_STATE_WITH_PLAN, { llmProvider: fakeProvider });
    expect(() => DraftSchema.parse(result.draft)).not.toThrow();
  });

  it('throws ValidationError when word count is wildly off target', async () => {
    const fakeProvider = new FakeLLMProvider({ text: TOO_SHORT_MARKDOWN });
    await expect(runArticleWriter(FIXTURE_STATE_WITH_PLAN, { llmProvider: fakeProvider }))
      .rejects.toThrow(ValidationError);
  });

  it('surfaces ProviderError when the provider call fails', async () => {
    const fakeProvider = new FakeLLMProvider({ throws: new ProviderError('article-writer', 'anthropic', 429, true) });
    await expect(runArticleWriter(FIXTURE_STATE_WITH_PLAN, { llmProvider: fakeProvider }))
      .rejects.toThrow(ProviderError);
  });
});
```

For deterministic, no-LLM modules (Portable Text Converter, Sanity Document Builder, slug logic), unit tests are ordinary input/output assertions with no fake provider needed at all — these are the cheapest, fastest, most exhaustive tests in the suite, and should have the highest coverage of edge cases (malformed Markdown AST shapes, slug collisions, every Portable Text invariant from `automation-integration.md`'s validation list).

## Contract tests (module-to-module)

A dedicated test file (`tests/fixtures/pipelineState.sample.json` + a contract-test suite) asserts that **the exact output shape of module N is valid input for module N+1**, using real schema validation (not mocks) chained across the boundary:

```ts
// tests/contract/moduleChain.test.ts (shape)
it('SeoPlan.internalLinkTargets is valid input to Internal Link Generator', () => {
  const seoPlan = SeoPlanSchema.parse(FIXTURE_SEO_PLAN);
  const linkGenInput = extractInternalLinkGeneratorInput({ seoPlan });
  expect(() => InternalLinkGeneratorInputSchema.parse(linkGenInput)).not.toThrow();
});
```

This is what catches "the contract in `04-json-contracts.md` and the actual code have drifted" before it becomes a runtime failure three modules downstream — the single highest-value test category for a pipeline built on the zero-transformation-contract principle, because that principle is only as good as its enforcement.

## Sandbox integration test

One slow, comprehensive test (`tests/integration/fullPipeline.sandbox.test.ts`) runs the entire orchestrator end-to-end against:
- A **separate Sanity sandbox dataset** (never the production dataset that Blogspage Agency reads from) — configured via a distinct `SANITY_DATASET` value in the test environment, per the environment-separation guidance in `knowledge/environment.md`.
- **Real provider calls at CHEAP tier only** (override `models.ts` for the test run so this suite costs pennies, not the full premium-tier run cost) — this test is checking end-to-end wiring and Sanity-write correctness, not article quality, so tier doesn't matter for what it's verifying.
- A fixed, deterministic Sheet-row fixture (not live Google Sheets) so the test is reproducible.

Assertions: the pipeline reaches `published` status; the created Sanity document passes every validation rule in `automation-integration.md`; a follow-up read confirms the document is fetchable; the test cleans up by deleting the sandbox document afterward (or the sandbox dataset is periodically wiped — either way, this test must never leave stray documents in a shared dataset).

This test is **not** run on every commit (it's slow and costs real, if small, money) — it runs in CI on merge to main and on a nightly schedule, while unit + contract tests run on every push.

## Testing the review loop and image loop specifically

Because these are the two places with bounded-iteration logic, they get dedicated orchestrator-level tests (not module-level) that verify:
- The loop actually terminates at `maxReviewIterations`/`maxImageRetries` and produces `failClosed`/graceful-degradation, using a `FakeLLMProvider` scripted to *always* return "needs revision" — proving the bound is enforced by code, not by hoping the model eventually agrees.
- A loop that resolves on iteration 1 doesn't run unnecessary extra iterations (cost/latency regression guard).
- `reviewLoop.iteration` in `PipelineState` increments exactly once per full loop pass, never per individual reviewer call.

## Testing prompts (a lighter-weight practice, not full CI automation)

Prompt files (`05-prompt-strategy.md`) are text, not code — they can't be unit-tested for "correctness" the way a function can. What's practical:
- **Snapshot tests on the interpolation layer** (`lib/prompts.ts`): given a fixed `vars` object, does `loadPrompt` produce the expected filled-in string, including shared-fragment resolution? This catches template/plumbing bugs, not content-quality regressions.
- **Manual quality review on prompt changes** — treated the same as a design-review step in a normal PR, not an automated gate. This is explicitly out of scope for automated CI; `12-future-roadmap.md` notes prompt-output-quality evaluation (e.g. an LLM-as-judge eval harness) as a post-v1 addition, not a v1 requirement.

## Testing provider adapters

Each adapter (`AnthropicProvider.ts`, etc.) has its own small unit test suite that mocks *that provider's SDK* (not the `LLMProvider` interface — this is the one layer where mocking the real SDK is correct and necessary, since the adapter's whole job is translating to/from that SDK's shapes). Assertions: request translation is correct, response translation produces a valid `LLMCallResult`, and every documented error status code maps to the correct `ProviderError` fields. These tests should never be run against a live API key in the default test run (an explicit, separately-flagged "live smoke test" per adapter is a reasonable pre-deploy check, but not part of the standard fast test suite).

## Coverage expectations (v1)

| Layer | Expectation |
|---|---|
| Deterministic modules (Portable Text, slug, Sanity Document Builder) | Near-exhaustive edge-case coverage — these are pure functions, cheap to test thoroughly |
| LLM-calling modules | Happy path + at least one schema-validation-failure path + at least one provider-error path, per module |
| Provider adapters | Happy path + every documented `ProviderError` status mapping |
| Orchestrator (loops, routing) | Every loop-termination condition (`pass`/`needsRevision`/`failClosed`, image-loop exhaustion) |
| Contract tests | Every module-to-module boundary named in `04-json-contracts.md`'s "Why this is a zero-transformation contract" section |
| Sandbox integration | One full happy-path run per CI merge/nightly; not required on every push |
