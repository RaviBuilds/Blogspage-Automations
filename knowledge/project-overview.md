# Project Overview — Blogspage Agency

## What this project is

Blogspage Agency is the production marketing + content website for "Blogspage," a
product-engineering agency that builds SaaS products, workflow automation, and AI
integrations for local/SMB businesses across 10 verticals (online delivery, hotels,
pet care, consulting, education, gyms, dental/medical, e-commerce, SaaS platforms,
SEO blogs). The pitch is "10-15 day launch window" for production-grade builds.

The site itself is the flagship demonstration of that capability: a Next.js 15
(App Router) marketing site + editorial blog + AI sales chatbot + programmatic
local-SEO landing pages, backed by Sanity as a headless CMS.

## Stack

| Layer | Technology |
| --- | --- |
| Framework | Next.js 15.3 (App Router, React Server Components, React 19) |
| Styling | Tailwind CSS v4, `tailwind-merge`, `class-variance-authority` |
| Animation | Framer Motion, Lenis (smooth scroll) |
| CMS | Sanity v3 (embedded Studio at `/studio`), `next-sanity` |
| Content model | Portable Text (`@portabletext/react`) |
| Syntax highlighting | Shiki (`github-dark-default` theme) |
| AI chat | Vercel AI SDK (`ai`, `@ai-sdk/react`, `@ai-sdk/openai`), NVIDIA's OpenAI-compatible endpoint, model `meta/llama-3.3-70b-instruct` |
| Validation | Zod v4 |
| Analytics | Vercel Analytics |
| Deployment | Vercel (implied by `vercel.md.md`, `@vercel/analytics`) |

## Top-level layout

```
Blogspage Agency/
├── src/
│   ├── app/            # Next.js App Router routes
│   ├── components/     # React components, organized by domain
│   ├── lib/             # Framework-agnostic business logic / utilities
│   ├── sanity/          # Sanity client, schemas, GROQ queries, structure
│   └── public/          # (present but currently unused — see note below)
├── public/              # Static assets served at the web root
├── sanity.config.ts      # Sanity Studio configuration (mounted at /studio)
├── sanity.cli.ts
├── next.config.ts        # Image remote patterns + legacy URL redirects
├── migrate.ts             # One-off WordPress → Sanity Portable Text importer
├── sanitize-data.ts       # One-off Portable Text repair script
├── diagnose-and-fix.ts    # One-off single-post Portable Text repair script
├── backfill-blog-meta.ts  # One-off excerpt backfill script
├── seed-meta.ts           # Seeds the default author + 4 categories
└── BLOGSPAGE_AI_CONTEXT.md # Pre-existing AI content-authoring guide (see caveat below)
```

Note: `src/public` exists alongside the standard Next.js `public/` at the project
root. All actual static assets (logo, favicon, placeholder images) live in the
root `public/`; `src/public` was not observed to contain referenced assets.

## Important caveat about `BLOGSPAGE_AI_CONTEXT.md`

The repo already contains a hand-written AI content-authoring guide at
`BLOGSPAGE_AI_CONTEXT.md`. It is thorough but **partially stale** relative to the
current schema and code:

- It documents `metaDescription` as the only required SEO field and does not
  mention `excerpt` — but `postType.ts` now requires `excerpt` (50-200 chars) too.
- Its sample GROQ queries are simplified/outdated versions of what
  `src/sanity/lib/queries.ts` actually runs (missing `evergreen`, `lastReviewed`,
  `faq`, `relatedPosts`, `focusKeyword`, `canonicalUrl`, `noindex`, `nofollow`,
  `ogTitle`, `ogDescription`, full `author`/`categories` projections, etc.).
- It states ISR revalidation is 60 seconds; the actual code revalidates the blog
  index every 300s and a single post every 3600s.

Treat the **code** (`src/sanity/schemaTypes/*.ts`, `src/sanity/lib/queries.ts`,
`src/app/(site)/blogs/**`) as ground truth. `BLOGSPAGE_AI_CONTEXT.md` is useful for
tone/voice and general Portable Text mechanics but should not be trusted for exact
field lists or requirements. See `recommended-improvements.md` for a suggestion to
reconcile this (documentation only — not implemented).

## Two-project relationship

This knowledge base lives in a **separate, standalone** project,
`Blogspage Automations` (Node.js + TypeScript), whose job is to build automation
that writes content into Blogspage Agency's Sanity dataset via the write client
contract described in `automation-integration.md`. Blogspage Automations does not
import Blogspage Agency's code — it talks to the same Sanity project over the API,
so it must independently replicate the schema's shape and rules.
