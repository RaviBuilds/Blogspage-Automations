# TypeScript Models

All blog-relevant types live in `src/sanity/lib/queries.ts`, hand-maintained
alongside their GROQ queries (no codegen). Reproduced here for automation
that needs to shape data compatibly without importing the website's code.

```ts
type FaqItem = {
  question: string
  answer: string
}

type PostCard = {
  _id: string
  title: string
  slug: string
  excerpt?: string
  imageUrl?: string
  imageAlt?: string
  publishedAt?: string
  featured?: boolean
  authorName?: string
  categories?: string[]        // titles, not slugs — flattened for card display
}

type LatestPost = {
  _id: string
  title: string
  slug: string
  excerpt?: string
  publishedAt?: string
}

type PostAuthor = {
  name?: string
  slug?: string
  jobTitle?: string
  imageUrl?: string
  sameAs?: string[]
}

type PostCategory = {
  title?: string
  slug?: string
}

type Post = {
  _id: string
  title: string
  slug: string
  excerpt?: string
  imageUrl?: string
  imageAlt?: string
  imageCaption?: string
  publishedAt?: string
  lastReviewed?: string
  _updatedAt?: string
  evergreen?: boolean
  content?: PortableTextBlock[]   // from @portabletext/types
  seoTitle?: string
  metaDescription?: string
  seoKeywords?: string[]
  focusKeyword?: string
  canonicalUrl?: string
  noindex?: boolean
  nofollow?: boolean
  ogTitle?: string
  ogDescription?: string
  ogImageUrl?: string
  faq?: FaqItem[]
  author?: PostAuthor
  categories?: PostCategory[]
  relatedPosts?: PostCard[]
}

type PostSitemapEntry = {
  slug: string
  publishedAt?: string
  lastReviewed?: string
  evergreen?: boolean
  _updatedAt?: string
}
```

## Important distinction: query-result types vs. write-document shape

**All of the above are read/projection types** — they describe what a GROQ
query returns (flattened URLs, resolved reference titles, etc.), **not** the
shape of a document you write to Sanity. A `post` document you `create()`
looks structurally different (raw references, raw image objects, raw
Portable Text with `_key`s) — see `automation-integration.md` for the actual
write-document JSON contract. Do not attempt to `client.create()` a `Post` or
`PostCard` object as defined here; it will not match the schema (e.g.
`categories` here is `PostCategory[]` with resolved `title`/`slug`, but the
schema field expects `{ _type: "reference", _ref: string, _key: string }[]`).

## `LeadInput` / `RecordLeadResult` (`src/lib/lead-store.ts`)

```ts
type LeadInput = {
  name: string
  email: string
  phone?: string | null
  businessName?: string | null
  industry?: string | null
  message?: string | null
  source?: string | null
  transcript?: string | null
}

type RecordLeadResult = {
  success: boolean
  id?: string
  persisted: boolean   // true only if actually written to Sanity (not just logged)
}
```

Not blog-related, but the only existing typed write-path contract in the
codebase — a useful shape reference for how this project models
success/failure of a Sanity write.
