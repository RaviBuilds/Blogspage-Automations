# 05 — Prompt Strategy

> **Superseded by `13-prompt-management-system.md`.** This document's original content (rule zero, the four-file pattern, shared fragments, `validation.md`/`repair.md` usage, prompt loading, versioning) has been carried forward, expanded, and made concrete in `13-prompt-management-system.md` — which adds the fifth file type (`examples.md`), the Prompt Registry abstraction, the naming-consistency fix (`_shared/` → `shared/`, module folders renamed to registry keys), inheritance/override resolution, and localization support. **Read `13-prompt-management-system.md` as the authoritative document for all prompt-related architecture.** This file is kept only as a short pointer, so links and history made against the original document still resolve to something meaningful rather than a dead reference.

## What's unchanged (confirmed, not revised)

Everything this document originally established as a *principle* remains correct and is restated, not contradicted, by `13-prompt-management-system.md`:

- No prompt text lives inline in `.ts`/`.js` code, ever.
- Prompts are plain Markdown with `{{mustache-style}}` placeholders — no YAML frontmatter, no code, reviewable by a non-engineer.
- `system.md` / `user.md` / `validation.md` / `repair.md` retain their original roles exactly as first specified.
- `validation.md`'s rubric is injected into `user.md` as a variable, not a second API call — unchanged.
- `repair.md`'s "smallest edit that resolves it" instruction, and the deliberate two-prompt split between Humanizer (whole-voice-pass) and Article Improver (targeted repair) — unchanged; see this document's original "Repair loop vs. regeneration" reasoning, preserved verbatim below since it doesn't need revision.
- Prompt versioning via git, no separate prompt-management service at v1 scale — unchanged in principle; `13-prompt-management-system.md` adds a `promptVersion` tag (the current repository HEAD short commit hash — a repository-wide value, not a per-prompt-folder hash) derived from git for per-run reproducibility, which is an addition, not a contradiction.

## What changed (see `13-prompt-management-system.md` for full detail)

| Original | Revised |
|---|---|
| Four file types (`system`/`user`/`validation`/`repair`) | Five — `examples.md` added, kept separate from `user.md` specifically to support future localization and A/B testing without touching the task template |
| `prompts/_shared/` | `prompts/shared/` (naming consistency — matches the "shared" vocabulary used everywhere else in this project, e.g. shared types, shared fragments) |
| Module folders named descriptively (`article-writer/`, `technical-reviewer/`) | Renamed to registry keys (`writer/`, `reviewer-technical/`) — one name shared across module folders, prompt folders, `CostEvent.moduleKey`, and the playground CLI (`16-developer-workflow-playground.md`) |
| `loadPrompt(path, vars)` — a module calls a path-based loader directly | `promptRegistry.get(key, vars)` — a module never knows a file path; the registry resolves inheritance/overrides internally (`13-prompt-management-system.md`'s Prompt Registry) |
| No inheritance/override mechanism | A resolution chain (tenant → locale → base) exists and is documented, even though v1 has zero overrides — built now so the first tenant/locale override later is a new folder, not a rewrite |
| No explicit output-formatting layering | A three-layer JSON-enforcement stack is now explicit: provider-native structured output (preferred) → prompt-level JSON contract (fallback) → `lib/json.ts`'s strict parse (last line of defense) |

## Repair loop vs. regeneration — a deliberate cost/quality choice (preserved, unchanged)

The system has two distinct "fix it" prompts (Humanizer's `user.md` and Article Improver's `repair.md`) rather than one generic "revise this" prompt, because they solve different problems with different blast radii:

| | Humanizer | Article Improver |
|---|---|---|
| Trigger | Always runs once per review loop iteration | Only runs when QA gate returns `needsRevision` |
| Scope of change | Whole-document voice pass | Targeted, issue-by-issue edits |
| Input | Full draft | Full draft + specific issue list |
| Cost profile | Full regeneration-scale (`06-cost-optimization.md`) | Same token scale, but rare (loop-only) |

Collapsing these into one prompt would either make Humanizer targeted (losing its whole-voice-pass value) or make Article Improver a full rewrite (losing the "minimal edit" cost and quality benefit) — keeping them separate is intentional, not duplication.
