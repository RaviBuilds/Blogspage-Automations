# SEO System — Where, How, and Why

## Where SEO lives

There is no separate "SEO" document type or plugin. SEO is implemented as:
1. A field group on `post` (fields: `focusKeyword`, `seoKeywords`, `seoTitle`,
   `metaDescription`, `canonicalUrl`, `noindex`, `nofollow` — see
   `sanity-schema.md`).
2. Render-time logic in `src/lib/blog.ts` (JSON-LD builders, description
   fallback resolution) and `src/app/(site)/blogs/[slug]/page.tsx`
   (`generateMetadata`).
3. Two Next.js metadata-route files: `src/app/sitemap.ts`, `src/app/robots.ts`.
4. Root-level defaults in `src/app/layout.tsx` (`metadataBase`, title template,
   default OG/Twitter image).

## How metadata resolves per post

`generateMetadata()` in `[slug]/page.tsx`:

| Output | Source (priority order) |
| --- | --- |
| `<title>` | `seoTitle` → `title` (decoded of HTML entities) |
| description | `resolveDescription()`: `metaDescription` → `excerpt` → `"Read {title} on the Blogspage journal."` |
| `keywords` | `seoKeywords` (omitted if empty) |
| `authors` | `[{ name: author.name }]` if present |
| canonical | `canonicalUrl` → self URL (`https://blogspage.com/blogs/{slug}`) |
| `robots.index` | `!noindex` |
| `robots.follow` | `!nofollow` |
| OG title/description | `ogTitle`/`ogDescription` → same fallback chain as above |
| OG image | `ogImageUrl` = `coalesce(ogImage.asset->url, mainImage.asset->url)` (resolved in the GROQ query itself, not in JS) |
| OG type | `"article"`, with `publishedTime`/`modifiedTime` |
| Twitter | `summary_large_image`, same title/description/image as OG |

If the post doesn't exist, `generateMetadata` returns
`{ title: "Post Not Found", robots: { index: false, follow: false } }` and the
page calls `notFound()`.

## Why: the design rationale baked into the schema comments

- `excerpt` is required specifically because it's reused for three purposes at
  once (card copy, description fallback, and "AI/LLM answer extraction") — one
  well-written field instead of three near-duplicate ones.
- `lastReviewed` exists distinctly from `_updatedAt` (Sanity's automatic system
  timestamp) because `_updatedAt` changes on *any* edit (even a typo fix),
  while `lastReviewed` is an editorial signal of genuine fact-checking —
  that's the field emitted as `dateModified` in JSON-LD, not `_updatedAt`
  (though `_updatedAt` is the fallback if `lastReviewed` is unset).
- `evergreen` exists to tune sitemap `changeFrequency` (`monthly` vs `weekly`)
  without needing a manual per-post cron.
- `internalLink` (reference-based) exists instead of plain URL links so that
  slug changes never break internal links — this is treated as the backbone
  of topical clustering for SEO in the schema's own doc comments.

## Structured data (JSON-LD) — `src/lib/blog.ts`

Three script tags are emitted on every post page:
1. **`BlogPosting`** (`buildArticleJsonLd`) — includes `headline`, resolved
   `description`, `image` (with caption), `datePublished`/`dateModified`,
   `author` (Person with `jobTitle`/url/`sameAs`, or Organization fallback if
   no author), `publisher` (always Blogspage Organization + logo),
   `keywords`, `articleSection` (all categories, not just primary),
   `wordCount`, `timeRequired` (ISO-8601 duration), `inLanguage: "en-US"`.
2. **`BreadcrumbList`** (`buildBreadcrumbJsonLd`) — `Home → Blog → {post
   title}`, always present.
3. **`FAQPage`** (`buildFaqJsonLd`) — only if `post.faq` is non-empty.

`/solutions/[slug]` pages emit a fourth kind, `ProfessionalService`, scoped to
`areaServed: City` (see `routing.md`).

## Sitemap (`src/app/sitemap.ts`)

Static entries: `/` (priority 1.0, weekly), `/blogs` (0.8, daily), `/contact`
(0.7, monthly), `/privacy` and `/terms` (0.2, yearly). Then every live,
non-`noindex` post at `/blogs/{slug}` (priority 0.6, `changeFrequency`
`monthly` if `evergreen` else `weekly`, `lastModified` =
`lastReviewed ?? _updatedAt ?? publishedAt`). Solution pages (`/solutions/*`)
are **not** currently included in the sitemap — see
`recommended-improvements.md`.

## Robots (`src/app/robots.ts`)

Allow `/` for all user agents, disallow `/studio` and `/studio/` (the CMS
editor is not content), points to `/sitemap.xml`, sets `host`.

## RSS

**No RSS feed exists.** No `feed.xml`/`rss.xml` route was found anywhere in
`src/app`.

## Canonical URLs

Every page sets `alternates: { canonical }` explicitly:
- Blog index: hardcoded `https://blogspage.com/blogs`.
- Post: `post.canonicalUrl` if set, else the post's own URL — self-canonicalizing
  is the default; `canonicalUrl` is only for genuinely syndicated/duplicate content.
- Solution pages: always self-canonical (`https://blogspage.com/solutions/{slug}`).

## Internal linking (SEO angle)

See `blog-system.md` for the mechanics. From an SEO strategy angle: the
`internalLink` annotation and `relatedPosts`/fallback system are the two
levers for topic-cluster interlinking; house style (per
`BLOGSPAGE_AI_CONTEXT.md` §12, still valid guidance) is to close every post
with one `ctaBlock` and use internal links naturally within the body rather
than a bolted-on "read more" list.

## Programmatic local SEO (`/solutions/[slug]`)

Not blog SEO, but part of the same overall SEO system: `src/lib/niches.ts`
defines a slug template per vertical
(`{niche}-business-solution-website-at-[city]`), currently only generated for
one city (`DEFAULT_CITY = "hyderabad"`) via `generateStaticParams()`. See
`routing.md` for the exact slug-matching mechanics.
