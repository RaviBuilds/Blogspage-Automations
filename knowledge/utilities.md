# Reusable Utilities — What Automation Should Reuse

This is the authoritative list of framework-agnostic logic automation should
mirror or call out to, rather than reinventing.

## `src/lib/blog.ts` — blog SEO/content helpers

| Export | Signature | Purpose |
| --- | --- | --- |
| `SITE_URL` | `"https://blogspage.com"` | Canonical base URL (duplicated elsewhere — see `metadata.md`) |
| `SITE_NAME` | `"Blogspage"` | Used in JSON-LD publisher/fallback description |
| `portableTextToPlain(blocks?)` | `PortableTextBlock[] → string` | Flattens Portable Text to plain text (ignores non-`block` types like images/CTAs) |
| `countWords(text)` | `string → number` | Whitespace-split word count |
| `getReadingTime(blocks?)` | `PortableTextBlock[] → number` | Minutes, `Math.max(1, round(words/225))` |
| `toIsoDuration(minutes)` | `number → string` | `"PT{n}M"` for JSON-LD `timeRequired` |
| `decodeHtmlEntities(text)` | `string → string` | Un-escapes `&amp; &lt; &gt; &quot; &#39;` |
| `postUrl(slug)` | `string → string` | `${SITE_URL}/blogs/${slug}` |
| `resolveDescription(post)` | `Post → string` | `metaDescription \|\| excerpt \|\| fallback sentence`, entity-decoded |
| `buildArticleJsonLd(post)` | `Post → object` | Full `BlogPosting` JSON-LD (see `seo-system.md`) |
| `buildBreadcrumbJsonLd(post)` | `Post → object` | `BreadcrumbList` JSON-LD |
| `buildFaqJsonLd(faq?)` | `FaqItem[] → object \| null` | `FAQPage` JSON-LD, `null` if empty |

**Constant to know:** `WORDS_PER_MINUTE = 225` (module-private, drives reading
time).

## `src/lib/highlight.ts` — syntax highlighting

| Export | Purpose |
| --- | --- |
| `resolveLanguage(language?)` | Maps a schema `codeBlock.language` value to a Shiki grammar name; unknown → `"text"` |
| `getBadgeLabel(language?)` | Maps to a short display badge (`TS`, `JS`, `TSX`, `JSON`, `Bash`, `CSS`, `HTML`, `GROQ`, `SQL`, `YAML`, `MD`, `Python`, `TEXT`); unknown → uppercased raw value |
| `highlightCode(code, language)` | `Promise<string>` of highlighted HTML, theme `github-dark-default`, lazily-initialized singleton highlighter |

Note: `GROQ` badge maps to Shiki's `text` grammar (Shiki has no GROQ grammar),
so GROQ code blocks display the badge "GROQ" but are not actually
syntax-colored.

## `src/lib/lead-store.ts` — lead persistence (not content, but the only
existing "write to Sanity" reference implementation)

| Export | Purpose |
| --- | --- |
| `isValidEmail(email)` | Regex `^[^\s@]+@[^\s@]+\.[^\s@]+$` |
| `recordLead(input: LeadInput): Promise<RecordLeadResult>` | Writes a `lead` document via `writeClient.create(doc)`. Degrades gracefully (logs instead of throwing) if `SANITY_WRITE_TOKEN` is unset. |

**This is the pattern to imitate for automation write operations**: always
route writes through the `writeClient` (never the read `client`), always
handle the missing-token case explicitly, always `console.log`/`console.error`
with a recognizable prefix (`"[Lead] ..."`) for observability, and return a
structured result object rather than throwing on expected failure paths.

## `src/lib/utils.ts`

| Export | Purpose |
| --- | --- |
| `cn(...inputs: ClassValue[])` | `twMerge(clsx(inputs))` — Tailwind class merging. UI-only, irrelevant to automation. |

## `src/lib/niches.ts` / `src/lib/services-catalog.ts`

Programmatic-SEO and AI-chat content data (see `architecture.md`,
`routing.md`). Not part of the blog content pipeline; listed for completeness
since automation should not confuse this with the blog schema.

## Sanity-side helpers (`src/sanity/lib/`)

| File | Export | Purpose |
| --- | --- | --- |
| `client.ts` | `client` | Read client, `useCdn: true` |
| `write-client.ts` | `writeClient` | Server-only write client, `SANITY_WRITE_TOKEN` |
| `image.ts` | `urlFor(source)` | `@sanity/image-url` builder, scoped to project/dataset |
| `env.ts` | `apiVersion`, `dataset`, `projectId` | Validated env accessors (`assertValue` throws if unset) |
| `queries.ts` | see `blog-system.md` | All GROQ queries + hand-written result types |
| `live.ts` | `sanityFetch`, `SanityLive` | Live Content API scaffold — defined but **unused** (see `recommended-improvements.md`) |

## One-off / operational scripts (root of Blogspage Agency, not `src/`)

These are **not** part of the runtime app (excluded from `tsconfig.json`'s
type-checking scope) but are directly relevant prior art for automation:

- `seed-meta.ts` — canonical slugify function + seeds author/categories.
  Confirms the exact `_id` naming convention (`author-ravi`,
  `category-{slug}`) and that `createOrReplace` is the idempotent write
  pattern used for reference data.
- `migrate.ts` — WordPress → Sanity importer: `htmlToBlocks` (from
  `@sanity/block-tools`) converting HTML into valid Portable Text, plus an
  `uploadImage()` helper (`client.assets.upload('image', buffer, {
  filename })`) — the reference implementation for turning an external image
  URL into a valid Sanity asset reference.
- `sanitize-data.ts` / `diagnose-and-fix.ts` — Portable Text repair scripts
  encoding the *exact* structural invariants a valid `content` array must
  satisfy (unique `_key`s, `children` containing only `span`s, no orphan
  `marks`, valid `markDefs` shapes, no stray fields on a block). These are the
  best available spec for "what does Sanity/Studio consider a broken Portable
  Text document" — automation-generated content should be validated against
  the same invariants before writing. See `automation-integration.md` §Validation.
- `backfill-blog-meta.ts` — shows the idiomatic environment-loading pattern
  (`dotenv` + `resolve(process.cwd(), ".env.local")`) and a dry-run flag
  convention (`--dry-run`) for one-off scripts that mutate the dataset.
