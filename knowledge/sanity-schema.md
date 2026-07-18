# Sanity Schema Reference

Source of truth: `src/sanity/schemaTypes/*.ts`, registered in
`src/sanity/schemaTypes/index.ts`. Registered document/object types:
`ctaBlock`, `blockContent`, `category`, `post`, `author`, `lead`.

Dataset: value of `NEXT_PUBLIC_SANITY_DATASET` (typically `production`).
API version: `NEXT_PUBLIC_SANITY_API_VERSION`, defaulting to `2026-06-14`
(`src/sanity/env.ts`).

## `post` (document) — the blog article

Field groups in Studio: `content` (default), `editorial`, `seo`,
`social` (Social/Open Graph), `structuredData` (FAQ).

| Field | Type | Required | Validation | Notes |
| --- | --- | --- | --- | --- |
| `title` | `string` | yes | min 15, max 90 (warnings) | H1 / headline |
| `slug` | `slug` | yes | — | `options.source: 'title'`, max 96 chars, uniqueness enforced by Studio's `defaultIsUnique` |
| `excerpt` | `text` (3 rows) | **yes** | min 50, max 200 chars (error) | Powers cards, meta-description fallback, RSS/LLM extraction. Must read as a standalone snippet. |
| `author` | `reference → author` | yes | — | Single reference |
| `mainImage` | `image` (hotspot) | no (recommended) | nested `alt` required *if* an asset is set (custom rule) | Also has `caption`, `credit` |
| `categories` | `array<reference → category>` | yes | min 1, max 3, unique | First category is treated as "primary" by convention (not enforced in schema, but used everywhere in code) |
| `publishedAt` | `datetime` | yes | — | Future dates = scheduled (hidden from live queries until `publishedAt <= now()`) |
| `content` | `blockContent` | yes | — | The body. See `blog-system.md` §Portable Text |
| `featured` | `boolean` | no | default `false` | Surfaces in featured/hero slots |
| `evergreen` | `boolean` | no | default `false` | Slower sitemap change-frequency, exempt from freshness nudges |
| `lastReviewed` | `datetime` | no | — | Emitted as `dateModified` in JSON-LD; freshness signal |
| `relatedPosts` | `array<reference → post>` | no | max 3, unique | Filtered to exclude drafts and self-reference. Falls back to automatic same-category query when empty |
| `focusKeyword` | `string` | no | — | Editorial-only, not rendered |
| `seoKeywords` | `array<string>` (tags UI) | no | unique, max 15 | Rendered as `<meta keywords>` and JSON-LD `keywords` |
| `seoTitle` | `string` | no | max 60 (warning) | Overrides `<title>`/search title; falls back to `title` |
| `metaDescription` | `text` (3 rows) | no | min 120, max 160 (warnings, not hard errors) | Falls back to `excerpt`, then a generated sentence |
| `canonicalUrl` | `url` | no | http/https scheme | Only for syndicated/migrated duplicate content |
| `noindex` | `boolean` | no | default `false` | Emits `robots: noindex` |
| `nofollow` | `boolean` | no | default `false` | Emits `robots: nofollow` |
| `ogTitle` | `string` | no | max 70 (warning) | Falls back to seoTitle/title |
| `ogDescription` | `text` (2 rows) | no | max 200 | Falls back to metaDescription/excerpt |
| `ogImage` | `image` (hotspot) | no | nested `alt` | Falls back to `mainImage`; reused for Twitter card |
| `faq` | `array<faqItem>` | no | max 10 | Each item: `question` (string, required, max 160), `answer` (text, required, min 20). Rendered on-page + FAQPage JSON-LD |

**IMPORTANT correction vs. `metaDescription`:** the schema file
(`postType.ts`) only applies `.min(120).warning(...)` and `.max(160).warning(...)`
— these are **warnings**, not `.error()`. `BLOGSPAGE_AI_CONTEXT.md` incorrectly
states this field is hard-required and hard-validated; `excerpt` is the field
that is actually hard-required (`.required()`, with `.error()` on length).
Automation should still aim for 120-160 chars on `metaDescription` as a quality
bar, but a document outside that range will still save/publish.

Studio orderings: "Published, newest first" (default sort used everywhere),
"Recently reviewed."

Studio preview: shows title, `by {author}`, flags for `★ Featured`,
`⏳ Scheduled` (future `publishedAt`), `⚠ No description` (missing both
`metaDescription` and `excerpt`).

## `category` (document)

Intentionally **flat** — no parent/child hierarchy (explicit design decision in
the schema comment; revisit only past ~15 categories).

| Field | Type | Required |
| --- | --- | --- |
| `title` | `string` | yes, max 50 |
| `slug` | `slug` | yes, `source: 'title'` |
| `description` | `text` (3 rows) | no, max 200 — used as category meta description |

Seeded categories (created by `seed-meta.ts`, stable IDs — reference, don't
duplicate):

| Title | `_id` | slug |
| --- | --- | --- |
| Web Development | `category-web-development` | `web-development` |
| AI & Automation | `category-ai-automation` | `ai-automation` |
| Programming | `category-programming` | `programming` |
| Tech Insights | `category-tech-insights` | `tech-insights` |

## `author` (document)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | `string` | yes | |
| `slug` | `slug` | yes | `source: 'name'` |
| `jobTitle` | `string` | no | schema.org `Person.jobTitle` |
| `image` | `image` (hotspot) | no | nested `alt` |
| `bio` | `array<block>` | no | minimal Portable Text: only `normal` style, no lists, decorators `strong`/`em`, one `link` annotation (`href` only) |
| `sameAs` | `array<url>` | no | unique, max 8, custom validator requires every URL start with `http(s)://`. Emits schema.org `Person.sameAs` (E-E-A-T signal) |

Seeded author: `author-ravi` / slug `ravi` / name "Ravi".

## `lead` (document)

Not blog-related — captured from the homepage form and the "Sweety" chat tool.
Append-only, CRM-inbox style.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | `string` | yes | |
| `email` | `string` | yes | regex `^[^\s@]+@[^\s@]+\.[^\s@]+$` |
| `phone` | `string` | no | |
| `businessName` | `string` | no | |
| `industry` | `string` | no | |
| `message` | `text` (4 rows) | no | project goal/challenge |
| `source` | `string` | no | default `"website"`; also seen: `"sweety-chat"` |
| `status` | `string` (radio) | no | one of `new`, `contacted`, `qualified`, `won`, `lost`; default `new` |
| `transcript` | `text` (6 rows) | no | full chat transcript when sourced from Sweety |
| `submittedAt` | `datetime` | no | default `now()` |

Automation should generally **not** need to touch `lead` — it belongs to the
sales pipeline, not content publishing.

## `ctaBlock` (object, embedded in `blockContent`)

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `headline` | `string` | yes | — |
| `body` | `text` (3 rows) | yes | — |
| `primaryLabel` | `string` | yes | `"Start a conversation"` |
| `secondaryLabel` | `string` | yes | — |
| `secondaryHref` | `string` | yes | relative path or full URL |

Front-end render guard (`[slug]/page.tsx`): only renders if `headline`, `body`,
`secondaryLabel`, AND `secondaryHref` are all present (the schema already
requires all five, so a validly-saved document always renders). The primary
button always opens the AI chat widget client-side regardless of any href.

## `blockContent` (array, the `post.content` field type)

See `blog-system.md` for the full Portable Text contract (styles, marks,
annotations, embedded object types, and exact JSON shapes).

## Studio desk structure (`src/sanity/structure.ts`)

Custom structure, not the default document-type list:
- **Posts** (parent list) →
  - All posts (sorted `publishedAt desc`)
  - Featured (`featured == true`)
  - Scheduled — future `publishedAt`
  - Needs SEO attention — missing both `metaDescription` and `excerpt`
- **Categories**, **Authors** (plain document lists)
- divider
- **Leads**
- divider
- everything else registered but not explicitly listed above (currently none,
  since all 6 types are accounted for)
