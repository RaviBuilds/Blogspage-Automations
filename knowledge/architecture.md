# Architecture

## Rendering model

Next.js 15 App Router with React Server Components. Almost everything is a server
component by default; `"use client"` is used only where interactivity is required
(chat widget, navbar scroll behavior, forms, copy button, smooth-scroll provider).

Route groups:
- `src/app/(site)/...` — the parenthesized `(site)` segment is a **route group**:
  it does not appear in the URL, but every route inside it shares
  `src/app/(site)/layout.tsx` (navbar, footer, chat widget, preloader, smooth
  scroll, custom cursor). Pages: `/`, `/blogs`, `/blogs/[slug]`, `/contact`,
  `/solutions/[slug]`, `/privacy`, `/terms`.
- `src/app/studio/[[...tool]]/page.tsx` — catch-all mount for the embedded Sanity
  Studio at `/studio`. Has its own minimal `layout.tsx` (no navbar/footer).
- `src/app/api/chat/route.ts` — the only API route; powers the "Sweety" AI chat.
- `src/app/actions/leads.ts` — a Server Action (`"use server"`), used by the
  homepage contact form instead of an API route.
- `src/app/sitemap.ts`, `src/app/robots.ts` — Next.js metadata-route conventions,
  auto-served at `/sitemap.xml` and `/robots.txt`.

## Data flow: Sanity → Next.js

1. Content is authored in Sanity Studio (`/studio`), which is the same Next.js
   app running the Studio UI via the `sanity` package, configured in
   `sanity.config.ts` and schema-registered from `src/sanity/schemaTypes/index.ts`.
2. Two Sanity clients exist:
   - `src/sanity/lib/client.ts` — **read** client, `useCdn: true` (fast, cached,
     eventually-consistent reads). Used by every public page.
   - `src/sanity/lib/write-client.ts` — **server-only** write client
     (`"server-only"` import guard), `useCdn: false`, authenticated with
     `SANITY_WRITE_TOKEN`. Used only by `src/lib/lead-store.ts` to persist leads.
   - A third helper, `src/sanity/lib/live.ts`, wires up `next-sanity`'s
     `defineLive`/`sanityFetch`/`SanityLive` for the Live Content API, but it is
     **not currently wired into any layout** (no `<SanityLive />` is rendered
     anywhere) — see `recommended-improvements.md`.
3. Pages fetch via `client.fetch<T>(QUERY, params)` using GROQ queries centralized
   in `src/sanity/lib/queries.ts`. Each query has a paired TypeScript type
   exported from the same file (`Post`, `PostCard`, `LatestPost`, etc.) — there is
   no `sanity typegen` codegen step; types are hand-maintained alongside queries.
4. Freshness is controlled per-route with Next.js's `export const revalidate = N`
   (ISR), not `useCdn: false` + on-demand revalidation:
   - `/blogs` (index): `revalidate = 300` (5 min).
   - `/blogs/[slug]` (post): `revalidate = 3600` (1 hour), plus
     `generateStaticParams()` pre-renders every known slug at build time.
   - `/solutions/[slug]`: fully static (`generateStaticParams()` from the niche
     matrix, no `revalidate` — content is code-defined, not CMS-defined).
   - Homepage's `latest-blogs.tsx` and `sitemap.ts` have no explicit `revalidate`
     export, so they follow the default dynamic/route-level behavior (sitemap.ts
     is dynamically computed on each request unless Next's own data cache kicks
     in via the underlying fetch).

## Content authority split

- **CMS-authored** (Sanity): blog posts, categories, authors, leads.
- **Code-authored** (TypeScript data files, not Sanity): the 10 solution-vertical
  landing pages come from `src/lib/niches.ts` (a large static array), not from a
  CMS document type. There is no Sanity schema for "niche" or "solution page."
  This is a deliberate architectural split — programmatic SEO pages are
  code/config, editorial blog content is CMS-authored.

## Middleware / redirects

No `middleware.ts`. Legacy-URL handling is done entirely via `next.config.ts`
`redirects()`:
- `/blog` → `/blogs`, `/blog/:slug` → `/blogs/:slug` (permanent).
- A catch-all regex redirects any bare top-level WordPress-style path
  (`blogspage.com/some-post-slug`) to `/blogs/some-post-slug`, excluding reserved
  app routes and static file extensions. This exists to preserve SEO equity from
  a prior WordPress site (see `migrate.ts`).

## Image domain allowlist

`next.config.ts` restricts `next/image` remote patterns to `cdn.sanity.io` only,
with `dangerouslyAllowSVG: true` and a locked-down `contentSecurityPolicy` for
served images. Any automation-uploaded image must go through Sanity's asset
pipeline (`cdn.sanity.io`) — `next/image` will reject any other remote host.

## Fonts & theming

Root layout (`src/app/layout.tsx`) sets `<html lang="en" className="dark">` —
the site is **dark-mode only**, no light theme toggle. Fonts are `Geist` /
`Geist Mono` from `next/font/google`, exposed as CSS variables consumed by
Tailwind (`font-sans`, `font-mono`).

## AI chat subsystem

`/api/chat` is a streaming route using the Vercel AI SDK against NVIDIA's
OpenAI-compatible API (`NVIDIA_API_KEY`, model `meta/llama-3.3-70b-instruct`). It
exposes a single tool, `save_lead`, gated by a strict Zod schema and a system
prompt with explicit anti-hallucination rules (never invent contact details).
Leads are persisted through the same `recordLead()` function used by the
homepage form (`src/lib/lead-store.ts`), so there is one lead-writing code path
regardless of source.
