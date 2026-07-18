---
name: blogspage-agency
description: Use this skill whenever building automation in Blogspage Automations that publishes, updates, or otherwise integrates with the Blogspage Agency website (blog posts, Sanity content, SEO metadata, images). Load it before writing any code that touches the Blogspage Agency Sanity dataset, so the automation stays contract-compliant with the production site.
---

# Blogspage Agency — Integration Skill

This skill summarizes everything learned from a full read-only audit of the
`Blogspage Agency` codebase (a production Next.js 15 + Sanity website). Its
purpose: every future Claude Code session working on `Blogspage Automations`
should understand this project *before* writing automation code, without
having to re-read the entire Blogspage Agency codebase each time.

**Full detail lives in `Blogspage Automations/knowledge/*.md`.** This skill is
the condensed map — read the relevant knowledge file for exact JSON shapes,
validation rules, and code references before implementing anything.

## Architecture overview

- Next.js 15 App Router, React 19 Server Components, Tailwind v4, dark-mode
  only. Sanity v3 headless CMS embedded at `/studio` in the same app.
- Two Sanity clients: a public `useCdn: true` read client
  (`src/sanity/lib/client.ts`) and a `"server-only"` write client
  authenticated with `SANITY_WRITE_TOKEN` (`src/sanity/lib/write-client.ts`).
  **Automation must use the write-client pattern — never the read client —
  for any mutation.**
- Blog content: CMS-authored (Sanity `post`/`category`/`author` documents).
- Programmatic local-SEO landing pages (`/solutions/[slug]`): **code**-authored
  from `src/lib/niches.ts`, not Sanity. Don't confuse the two systems.
- ISR caching: blog index revalidates every 5 min, single posts every 1 hour.
  No webhook/on-demand revalidation exists — a freshly-published automated
  post can take up to an hour to reflect on an already-cached page.
- Full detail: `knowledge/architecture.md`, `knowledge/project-overview.md`.

## Coding conventions observed in Blogspage Agency

- TypeScript everywhere, strict mode. Sanity schemas use `defineType`/
  `defineField`/`defineArrayMember` from the `sanity` package.
- GROQ queries and their matching result types are hand-maintained together
  in one file (`src/sanity/lib/queries.ts`) — no Sanity TypeGen codegen.
- Server components by default; `"use client"` only where interactivity is
  needed.
- One-off/maintenance scripts (migration, seeding, repair) live at the
  project root, are excluded from `tsconfig.json`'s type-checked scope, load
  env via `dotenv` + `.env.local`, and use `createOrReplace` for idempotent
  seeding.
- Slugify convention (canonical, from `seed-meta.ts`): lowercase → strip `&`
  → collapse non-alphanumeric runs to `-` → trim edge hyphens.

## Sanity integration

- Registered types: `post`, `category`, `author`, `lead`, plus embedded
  object types `blockContent`, `ctaBlock`.
- `post` requires: `title`, `slug`, `excerpt` (50-200 chars, **hard** schema
  error outside that range — the only hard-required length constraint in the
  whole schema), `author` (ref), `categories` (1-3 refs), `publishedAt`,
  `content` (Portable Text).
- No `tag` document type — use `post.seoKeywords` (string array) instead.
- Categories are intentionally flat (no hierarchy) by design decision.
- Full field tables: `knowledge/sanity-schema.md`.

## SEO strategy

- SEO fields live directly on `post` (no separate SEO document): `seoTitle`,
  `metaDescription`, `seoKeywords`, `focusKeyword`, `canonicalUrl`,
  `noindex`/`nofollow`, `ogTitle`/`ogDescription`/`ogImage`.
- `metaDescription` 120-160 chars is a **warning**, not a hard block — don't
  assume the API will reject an out-of-range value; `excerpt` is the field
  that's actually enforced.
- Three JSON-LD types generated at render time from document fields:
  `BlogPosting`, `BreadcrumbList`, and conditionally `FAQPage`. Automation
  gets good structured data for free just by populating the right fields —
  it never needs to write JSON-LD itself.
- Full detail: `knowledge/seo-system.md`, `knowledge/metadata.md`.

## Blog rendering pipeline

- Body format is **Portable Text JSON only** — never Markdown, never raw
  HTML. Allowed block styles: `normal`, `h2`, `h3`, `h4`, `blockquote` (no
  `h1`/`h5`/`h6` — the post title is already the page's H1).
- Two link annotation types: `link` (external) and `internalLink`
  (reference-based, to another `post` — prefer this for internal links since
  it survives slug renames).
- Embedded object types inside `content`: `image`, `codeBlock` (syntax
  highlighted server-side via Shiki), `ctaBlock` (all 5 fields required).
- Full detail + exact JSON block shapes: `knowledge/blog-system.md`,
  `knowledge/automation-integration.md`.

## Reusable utilities to call out to (or mirror) rather than reinvent

- `src/lib/blog.ts`: reading time, JSON-LD builders, description-fallback
  resolution, HTML entity decoding.
- `src/lib/highlight.ts`: Shiki language/badge mapping.
- `src/lib/lead-store.ts`: reference implementation for "write to Sanity with
  graceful degradation if the write token is missing."
- `seed-meta.ts`, `migrate.ts`, `sanitize-data.ts`, `diagnose-and-fix.ts`
  (project root, Blogspage Agency): prior art for slugify, HTML→Portable Text
  conversion, image upload, and Portable Text structural repair. These
  encode the exact validity invariants Sanity/Studio expect.
- Full list: `knowledge/utilities.md`.

## Automation contract (the most important part)

Automation talks to Blogspage Agency **only** via the Sanity Content Lake
API — there is no HTTP API of Blogspage Agency's own. Read
`knowledge/automation-integration.md` in full before writing any post-
creation code. Key points:

- Connect with the same `projectId`/`dataset` as the website, a write-scoped
  `SANITY_WRITE_TOKEN`, `useCdn: false`.
- Upload images via `client.assets.upload("image", buffer, { filename })`
  first; never fabricate an `asset._ref`.
- Self-validate Portable Text structure before writing (unique `_key`s,
  `children` containing only `span`s, valid `markDefs` shapes, no orphan
  marks) — Sanity's raw API will accept structurally invalid content that
  later breaks the Studio editor or renderer.
- Self-check slug uniqueness before creating — Studio's uniqueness validator
  does not run on raw API writes.
- Never change a published post's slug.

## Do's and don'ts

**Do:**
- Read the relevant `knowledge/*.md` file before implementing a feature.
- Treat the schema files (`src/sanity/schemaTypes/*.ts` — read-only reference
  copies of the logic are summarized in `knowledge/sanity-schema.md`) as
  ground truth over `BLOGSPAGE_AI_CONTEXT.md`, which is stale in places.
- Route all Sanity content through Portable Text JSON, never Markdown/HTML.
- Use `seoKeywords` for tag-like behavior.
- Prefer `internalLink` annotations over raw URLs when linking to other
  Blogspage posts.
- Validate Portable Text structure and slug uniqueness client-side before
  writing.

**Don't:**
- Never modify, refactor, or optimize anything inside `Blogspage Agency` —
  it is a production application and is read-only for this project.
- Never invent a `tag` schema type.
- Never store Markdown or raw HTML in a post's `content` field.
- Never assume `metaDescription` length is enforced — `excerpt` is the field
  that's hard-required.
- Never fabricate a Sanity image asset reference.
- Never conflate the blog's Sanity-backed slug system with the
  code-driven `/solutions/[slug]` niche routing system — they are unrelated.

## Integration checklist (before publishing a post via automation)

- [ ] `title` (15-90 chars), `slug` (unique, correct slugify algorithm)
- [ ] `excerpt` 50-200 chars (hard requirement)
- [ ] `author` references an existing `author` document
- [ ] `categories`: 1-3 references to existing `category` documents
- [ ] `publishedAt` is a valid ISO 8601 datetime
- [ ] `content` is valid Portable Text (unique `_key`s, valid `markDefs`,
      only `span` children, allowed `style`/`listItem` values)
- [ ] `mainImage` set with `alt` if an asset is present
- [ ] `metaDescription` ideally 120-160 chars (soft target)
- [ ] At least one `internalLink` to another live post, where relevant
- [ ] Exactly one closing `ctaBlock` with all 5 fields populated
- [ ] Slug uniqueness self-checked (query Sanity before creating)
- [ ] No Markdown/HTML anywhere in `content`

## Known gaps / stale docs (see `knowledge/recommended-improvements.md`)

`BLOGSPAGE_AI_CONTEXT.md` in Blogspage Agency is outdated relative to the
current schema. There's no on-demand revalidation webhook, so freshly
published content can take up to an hour to appear on cached pages. These are
documented as recommendations only — nothing has been changed in Blogspage
Agency.
