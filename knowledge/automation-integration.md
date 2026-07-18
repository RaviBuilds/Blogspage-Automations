# Automation Integration Contract

**This is the contract between Blogspage Automations and Blogspage Agency.**
Everything here is derived directly from `src/sanity/schemaTypes/*.ts`,
`src/sanity/lib/*.ts`, and the repair scripts (`sanitize-data.ts`,
`diagnose-and-fix.ts`) — not from `BLOGSPAGE_AI_CONTEXT.md`, which is stale in
places (see `project-overview.md`). Where the two disagree, this document and
the schema files win.

Automation talks to Blogspage Agency **only** through the Sanity Content
Lake API (via `@sanity/client` or `next-sanity`'s client), using the same
`projectId`/`dataset` as the website and a write-capable token. There is no
HTTP API of Blogspage Agency's own to call (see `api-endpoints.md`).

## Connection setup (mirrors `src/sanity/lib/write-client.ts`)

```ts
import { createClient } from "@sanity/client";

const writeClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,   // same value as website's NEXT_PUBLIC_SANITY_PROJECT_ID
  dataset: process.env.SANITY_DATASET,        // same value as website's NEXT_PUBLIC_SANITY_DATASET
  apiVersion: "2026-06-14",                    // match src/sanity/env.ts default, or query it
  useCdn: false,                                // writes must never go through the CDN
  token: process.env.SANITY_WRITE_TOKEN,        // needs create + update permission
});
```

## Required JSON structure for a new post

```json
{
  "_type": "post",
  "title": "Why Direct Booking Beats OTAs for Independent Hotels",
  "slug": { "_type": "slug", "current": "why-direct-booking-beats-otas" },
  "excerpt": "OTAs quietly drain hotel margin on every booking. Here's how a direct booking engine with a live room matrix reclaims that revenue.",
  "author": { "_type": "reference", "_ref": "author-ravi" },
  "publishedAt": "2026-07-17T09:00:00.000Z",
  "categories": [
    { "_type": "reference", "_ref": "category-tech-insights", "_key": "cat1" }
  ],
  "mainImage": {
    "_type": "image",
    "alt": "Hotel front desk dashboard showing a live room matrix",
    "asset": { "_type": "reference", "_ref": "image-<assetId>-1600x900-jpg" }
  },
  "featured": false,
  "evergreen": false,
  "focusKeyword": "direct booking hotel",
  "seoKeywords": ["direct booking", "hotel OTA fees", "room matrix", "Next.js"],
  "seoTitle": "Direct Booking vs OTAs for Independent Hotels",
  "metaDescription": "OTAs quietly drain hotel margin. Here is how a direct booking engine with a live room matrix reclaims revenue and prevents double-bookings.",
  "content": [ /* Portable Text blocks — see below */ ],
  "faq": [
    { "_type": "faqItem", "_key": "faq1", "question": "...", "answer": "..." }
  ]
}
```

### Required fields (write will fail Studio validation, though a raw API
`create()` call can still technically succeed — always match these anyway)

| Field | Rule |
| --- | --- |
| `title` | 15-90 chars (warnings only, not hard-blocking at the API level, but treat as required) |
| `slug.current` | non-empty, unique among `post` documents, ≤ 96 chars |
| `excerpt` | **50-200 chars, hard error if outside range** — this is the one field the schema enforces with `.error()`, not just `.warning()` |
| `author` | valid reference to an existing `author` document |
| `categories` | 1-3 unique references to existing `category` documents |
| `publishedAt` | ISO 8601 datetime string |
| `content` | non-empty Portable Text array |

### Strongly recommended (no hard validation, but expected for a complete post)

`mainImage` (with `alt` if an asset is set), `seoTitle` (≤60 chars),
`metaDescription` (aim 120-160 chars — warning-only, not blocking), one
closing `ctaBlock` inside `content`.

## Required image metadata

Images cannot be inlined as URLs. Upload first, then reference:

```ts
const asset = await writeClient.assets.upload("image", imageBuffer, {
  filename: "hotel-room-matrix.jpg",
});
// asset._id looks like "image-abc123...-1600x900-jpg"
```

Then use `{ "_type": "reference", "_ref": asset._id }` as the `asset` value
inside any `image` field (`mainImage`, `ogImage`, or an in-content `image`
block). Every image field with an asset **must** carry a non-empty `alt`
string (custom schema validator — see `sanity-schema.md`).

## Required SEO fields

See the table above. In priority: `excerpt` is mandatory; `metaDescription`,
`seoTitle`, `seoKeywords`, `focusKeyword` are all optional but expected for a
"complete" post per house convention. `canonicalUrl` should be omitted
entirely unless the post is a genuine syndication/duplicate of content
published elsewhere first.

## Required Sanity fields (reference data — do not invent new IDs casually)

- Author: reference an existing author (`author-ravi` is the seeded default)
  or create a new `author` document first and reference its real `_id`.
- Categories: reference one of the four seeded categories
  (`category-web-development`, `category-ai-automation`,
  `category-programming`, `category-tech-insights`) unless a genuinely new
  topic warrants a new category — creating a new category is a real content
  decision (topic taxonomy), not just a technical stub, so avoid doing this
  silently in an automated pipeline. If new categories are needed regularly,
  document that as a `recommended-improvements.md` item rather than
  auto-creating them ad hoc.

## Required slugs

Use the exact slugify algorithm in `seed-meta.ts` (see `slug-system.md`):
lowercase → strip `&` → collapse any non-alphanumeric run to a single hyphen
→ trim leading/trailing hyphens. Check for uniqueness against existing `post`
documents before creating (a raw API write does not enforce Studio's
uniqueness rule).

## Required "markdown format" / frontmatter

**There is no Markdown format and no frontmatter.** The body must be
Portable Text JSON from the first write — if the content-generation pipeline
produces Markdown internally, it must be converted to Portable Text blocks
before calling `client.create()`. Do not store Markdown strings in the
`content` field; the front end will not render them (it renders `content`
exclusively through `@portabletext/react`, which expects the Portable Text
block-array shape, not a Markdown string).

### Portable Text block shapes (exact, matching `blockContentType.ts`)

**Paragraph:**
```json
{ "_type": "block", "_key": "b1", "style": "normal", "markDefs": [],
  "children": [ { "_type": "span", "_key": "b1s1", "text": "Plain text.", "marks": [] } ] }
```

**Heading** (allowed styles: `normal`, `h2`, `h3`, `h4`, `blockquote` — **not**
`h1`, `h5`, or `h6`; the post title is already the page's `<h1>`, so body
headings should start at `h2`):
```json
{ "_type": "block", "_key": "h2a", "style": "h2", "markDefs": [],
  "children": [ { "_type": "span", "_key": "h2as1", "text": "The Commission Problem", "marks": [] } ] }
```

**Decorators** (`marks` values: `strong`, `em`, `underline`, `strike-through`, `code`):
```json
{ "_type": "span", "_key": "b2s2", "text": "atomic allocation", "marks": ["strong"] }
```

**External link** (annotation `link`, declared in `markDefs`, referenced by `_key` from a span's `marks`):
```json
{
  "_type": "block", "_key": "b3", "style": "normal",
  "markDefs": [ { "_key": "link1", "_type": "link", "href": "https://nextjs.org", "blank": true, "nofollow": false } ],
  "children": [
    { "_type": "span", "_key": "b3s1", "text": "Read the ", "marks": [] },
    { "_type": "span", "_key": "b3s2", "text": "Next.js docs", "marks": ["link1"] },
    { "_type": "span", "_key": "b3s3", "text": ".", "marks": [] }
  ]
}
```

**Internal link** (annotation `internalLink`, references a `post` document —
prefer this over a raw URL whenever linking to another Blogspage post, since
it survives slug changes):
```json
{
  "_type": "block", "_key": "b4", "style": "normal",
  "markDefs": [ { "_key": "il1", "_type": "internalLink", "reference": { "_type": "reference", "_ref": "<other-post-_id>" } } ],
  "children": [
    { "_type": "span", "_key": "b4s1", "text": "our guide to Core Web Vitals", "marks": ["il1"] }
  ]
}
```

**Bullet / numbered list item:**
```json
{ "_type": "block", "_key": "li1", "style": "normal", "listItem": "bullet", "level": 1,
  "markDefs": [], "children": [ { "_type": "span", "_key": "li1s1", "text": "Own your customer relationship.", "marks": [] } ] }
```
(`"listItem": "number"` for ordered lists.)

**Blockquote:**
```json
{ "_type": "block", "_key": "q1", "style": "blockquote", "markDefs": [],
  "children": [ { "_type": "span", "_key": "q1s1", "text": "Performance is a feature.", "marks": [] } ] }
```

**Embedded image:**
```json
{ "_type": "image", "_key": "img1", "alt": "Architecture diagram of the dispatch system",
  "asset": { "_type": "reference", "_ref": "image-<assetId>-1200x800-png" }, "caption": "Optional caption" }
```

**Embedded code block:**
```json
{ "_type": "codeBlock", "_key": "code1", "language": "typescript", "filename": "queries.ts",
  "code": "export const POSTS_QUERY = `*[_type == \"post\"]`" }
```
Allowed `language` values: `text`, `typescript`, `javascript`, `tsx`, `json`,
`bash`, `css`, `html`, `groq`, `sql`.

**Embedded CTA (all 5 fields are schema-required):**
```json
{
  "_type": "ctaBlock", "_key": "cta1",
  "headline": "Ready to own your booking channel?",
  "body": "Tell us about your property and we'll map a 10-15 day launch plan.",
  "primaryLabel": "Talk to our AI",
  "secondaryLabel": "See how we work",
  "secondaryHref": "/#process"
}
```

## Required internal links

Not schema-required, but a house convention worth encoding as a soft
requirement in automation: every post should contain at least one
`internalLink` annotation pointing to another live post (topic clustering),
and should close with exactly one `ctaBlock`.

## Required "schema" (in the JSON-LD sense, i.e. what feeds structured data)

Automation does not need to write JSON-LD directly — it's generated at render
time from the document fields (`src/lib/blog.ts`). To get good structured
data for free, populate: `excerpt`/`metaDescription` (description),
`mainImage` (+`alt`, +optional `caption` → `ImageObject`), `author` (with
`jobTitle`/`sameAs` on the author document for full E-E-A-T signal),
`categories` (→ `articleSection`), `seoKeywords` (→ `keywords`), `faq` (→
`FAQPage`), and `lastReviewed` whenever content is meaningfully updated (→
`dateModified`).

## Required validations before writing (mirrors `sanitize-data.ts` /
`diagnose-and-fix.ts` invariants — validate client-side in the automation
before calling Sanity, since Sanity's API will accept structurally-invalid
Portable Text that later breaks rendering or the Studio editor)

1. Every array item in `content`, `categories`, `children`, and `markDefs`
   has a unique, non-empty `_key` string.
2. A block's `children` array contains **only** `span` objects — never nested
   blocks, arrays, or other object types.
3. A span's `marks` array may only contain: an allowed decorator name
   (`strong`, `em`, `underline`, `strike-through`, `code`) **or** a key that
   exists in that same block's `markDefs`. No orphan mark references.
4. `markDefs` entries are only ever `{ _key, _type: "link", href, blank?, nofollow? }`
   or `{ _key, _type: "internalLink", reference }` — no other markDef shapes.
5. A block object has only these keys: `_type`, `_key`, `style`, `listItem`,
   `level`, `children`, `markDefs`. No stray extra fields.
6. `style` is one of `normal`, `h2`, `h3`, `h4`, `blockquote`. `listItem` is
   `bullet` or `number` (only present on genuine list items).
7. `metaDescription`, if present, should be 120-160 chars (soft — won't block
   a write, but violates house SEO quality bar). `excerpt` **must** be 50-200
   chars (hard schema requirement).
8. `href` values on `link` markDefs must be non-empty absolute URLs (or a
   clean relative path for internal-style external links); `reference` on
   `internalLink` markDefs must point at a real, existing `post` `_id`.
9. `seoTitle` ≤ 60 chars, `ogTitle` ≤ 70 chars, `ogDescription` ≤ 200 chars,
   `faq[].question` ≤ 160 chars, `faq[].answer` ≥ 20 chars, `seoKeywords`
   unique and ≤ 15 items, `categories` unique and 1-3 items, `relatedPosts`
   unique and ≤ 3 items.

## Freshness / propagation caveat

There is no webhook or on-demand-revalidation endpoint (`api-endpoints.md`).
After a `client.create()`, expect the new post to appear on `/blogs` within
~5 minutes (300s revalidate) and to be reachable directly at `/blogs/{slug}`
immediately (dynamic render on first hit if not yet statically generated),
but it will not be included in `sitemap.xml` until the next time that route
is requested/regenerated, and updates to an *existing* post can take up to an
hour to propagate to already-cached pages (3600s revalidate) plus whatever
latency the Sanity CDN (`useCdn: true` on the read client) adds on top.

## What automation should never do (recap of the file's own rules)

- Never write directly to Blogspage Agency's source files — this contract is
  API-only, mediated entirely through Sanity.
- Never fabricate an image `asset._ref` — always upload first.
- Never store Markdown or HTML in `content`.
- Never invent a `tag` document type — use `seoKeywords`.
- Never change a published post's `slug` once live.
- Never assume a raw `client.create()` call is validated the way Studio would
  validate it — always self-validate against the rules above before writing.
