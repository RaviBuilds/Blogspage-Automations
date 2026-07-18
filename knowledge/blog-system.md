# Blog System — How It Actually Works

## Storage model

Blog posts are `post` documents in Sanity (see `sanity-schema.md`). The body
lives in the `content` field, typed `blockContent`, which is **Portable Text**
(structured JSON blocks) — never Markdown, never raw HTML. `migrate.ts` converts
legacy WordPress HTML into Portable Text via `@sanity/block-tools` at import
time; nothing downstream ever parses HTML or Markdown at render time.

## GROQ queries (source: `src/sanity/lib/queries.ts`)

A single filter constant defines "what is publicly visible," reused everywhere:

```groq
_type == "post" && !(_id in path("drafts.**")) && defined(slug.current)
  && defined(publishedAt) && publishedAt <= now()
```

This means: not a draft, has a slug, has a publish date, and that date is not in
the future (scheduled publishing). Note this filter does **not** exclude
`noindex` posts from normal fetches — `noindex` only removes a post from the
**sitemap** query (`POST_SITEMAP_QUERY` adds `&& noindex != true`) and adds a
`noindex` robots meta tag; the post page itself still renders and is reachable
by direct URL.

Queries and what they power:
- `POSTS_QUERY` — full blog index (`/blogs`), ordered `featured desc,
  publishedAt desc`.
- `LATEST_POSTS_QUERY` — homepage rail, newest 3, no featured-boost.
- `POST_QUERY` — single post by `$slug`, includes everything needed to render
  the page, build `<meta>`/OG/Twitter tags, and build all three JSON-LD blocks
  (author with `jobTitle`/`sameAs`, categories, `relatedPosts` resolved
  eagerly if hand-picked).
- `RELATED_POSTS_FALLBACK_QUERY` — used only when `post.relatedPosts` is empty;
  finds up to 3 other live posts sharing at least one category, newest first.
- `POST_SITEMAP_QUERY` — slugs + `lastReviewed`/`evergreen`/`_updatedAt` for
  `sitemap.ts`.
- `POST_SLUGS_QUERY` — bare slugs, used by `generateStaticParams()`.

Each query has a hand-written matching TypeScript type in the same file
(`Post`, `PostCard`, `LatestPost`, `PostAuthor`, `PostCategory`,
`PostSitemapEntry`, `FaqItem`). There is **no Sanity TypeGen** step — if the
GROQ projection changes, the type must be updated by hand in the same file.

## Taxonomy

- **Categories**: `post.categories` is an array of references (1-3, unique).
  Convention (not schema-enforced): `categories[0]` is treated as the "primary"
  category everywhere it's surfaced (blog card pill, post header pill,
  `articleSection` in JSON-LD uses all of them, but list/card UI shows only the
  first).
- **Authors**: single reference, required.
- **Tags**: there is **no separate tag document type**. Tag-like behavior is the
  `seoKeywords` string array (rendered as a tags-layout UI in Studio). Never
  invent a `tag` reference type.

## Images

- **Featured image**: `mainImage` (hotspot-enabled `image`, nested `alt` /
  `caption` / `credit`). Rendered 16:9 on both the blog card and the post hero.
- **In-content images**: `blockContent` array members of type `image`
  (hotspot, nested `alt` required-if-asset-present, `caption`). Rendered
  full-width in the post body, wrapped `not-prose` so they break out of the
  Tailwind Typography flow.
- **OG image**: `ogImage`, falls back to `mainImage`. Recommended size
  1200×630 (that's the exact width/height passed to the OG `images` array).
  The same image is reused for the Twitter card (`summary_large_image`) — there
  is no separate Twitter-only image field.
- See `image-system.md` for the full asset/URL pipeline.

## Markdown / rich text / syntax highlighting

- Body format is Portable Text only. See `blockContent` type spec in
  `sanity-schema.md` and the exact JSON shapes in `automation-integration.md`.
- Allowed block styles: `normal`, `h2`, `h3`, `h4`, `blockquote` (the schema
  does **not** register `h1`/`h5`/`h6`, unlike what `BLOGSPAGE_AI_CONTEXT.md`
  claims — check `blockContentType.ts` `styles` array, which lists exactly
  `normal, h2, h3, h4, blockquote`). Because the post's `title` already renders
  as the page's `<h1>`, body content should start headings at `h2`.
- Lists: `bullet`, `number`.
- Decorators (inline marks): `strong`, `em`, `underline`, `strike-through`,
  `code`.
- Annotations: **two**, not one — `internalLink` (a `reference → post` object,
  required) and `link` (external, `href: url`, `blank: boolean` default
  `true`, `nofollow: boolean` default `false`). `BLOGSPAGE_AI_CONTEXT.md`
  documents only the old single `link` annotation and misses `internalLink`
  entirely — this is the current backbone of internal linking/topic clusters
  and should be used whenever a post references another post, instead of a
  raw URL.
- Code blocks: a `codeBlock` object type (fields: `language` enum — `text`,
  `typescript`, `javascript`, `tsx`, `json`, `bash`, `css`, `html`, `groq`,
  `sql` — `code` text required, optional `filename`). Rendered by
  `CodeBlock.tsx` using **Shiki** with the `github-dark-default` theme,
  producing highlighted HTML server-side (it's an async server component),
  with a copy-to-clipboard button (`CopyButton.tsx`, client component).
  `src/lib/highlight.ts` maps schema language values to Shiki grammar names
  and to short display badges (`TS`, `JS`, `TSX`, etc.); unknown languages fall
  back to `text`/`CODE`.
- Embedded CTA: a `ctaBlock` object member (see `sanity-schema.md`), rendered
  by `BlogFooterCTA.tsx`.

## Reading time

Computed at render time (not stored), by `src/lib/blog.ts`:
`getReadingTime(blocks)` → extracts plain text from Portable Text
(`portableTextToPlain`), counts words, divides by 225 wpm, rounds, minimum 1
minute. Also exposed as an ISO-8601 duration (`toIsoDuration`, e.g. `"PT5M"`)
for the JSON-LD `timeRequired` field.

## Related posts

`post.relatedPosts` lets an editor hand-pick up to 3 posts (self-reference and
drafts excluded by a Studio-side reference filter). If empty, the page falls
back to `RELATED_POSTS_FALLBACK_QUERY` (same-category, newest-first, excludes
current post). This resolution happens in `getRelatedPosts()` inside
`[slug]/page.tsx`.

## Breadcrumbs

Not a stored field — computed at render time by
`buildBreadcrumbJsonLd(post)` in `src/lib/blog.ts`: `Home → Blog → {post
title}`. This exists **only** as structured data (schema.org `BreadcrumbList`)
for SERP breadcrumb rendering; there is no visible on-page breadcrumb UI
component.

## FAQ

`post.faq` (array of Q&A pairs, max 10). If present, rendered as a visible
`<dl>` section near the end of the article **and** emitted as `FAQPage`
JSON-LD via `buildFaqJsonLd()`. If empty, both the section and the script tag
are omitted (`buildFaqJsonLd` returns `null` for an empty/undefined array).

## Search

There is **no search feature** on the blog (no search box, no search API, no
Algolia/etc. integration observed anywhere in the codebase).

## Internal linking

Two mechanisms:
1. In-body `internalLink` mark annotations (reference-based, slug-independent —
   survives slug renames).
2. `relatedPosts` (hand-picked or auto-fallback) rendered as a "Related
   reading" section at the end of the article.
There's also the always-present closing `ctaBlock`, which is a conversion link
(not really "internal linking" for SEO purposes, but worth noting as the
standard closing element of every post per house style).

## Static generation / ISR / caching

- `/blogs` (index): `export const revalidate = 300`. No `generateStaticParams`
  (it's a single dynamic-content page, not per-item).
- `/blogs/[slug]`: `export const revalidate = 3600`, plus
  `generateStaticParams()` pulling every slug via `POST_SLUGS_QUERY` so all
  known posts are pre-rendered at build time; new posts published after build
  are rendered on first request and then cached per the ISR interval.
- Read client uses `useCdn: true` (Sanity's CDN, eventually consistent, ~cache
  window measured in seconds) — this is layered *underneath* Next's own ISR
  cache, so a post can take up to ~(Sanity CDN latency + up to `revalidate`
  seconds) to reflect a Studio edit on the live site.
- The Live Content API scaffold (`sanity/lib/live.ts`) exists but is **not**
  actually mounted (`<SanityLive />` isn't rendered in any layout) — so it has
  no effect currently. See `recommended-improvements.md`.
