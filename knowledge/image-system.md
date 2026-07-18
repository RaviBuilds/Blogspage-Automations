# Image System

## How images are uploaded / stored

Sanity images are **asset references**, never raw URLs, in the document JSON:

```json
{
  "_type": "image",
  "alt": "Descriptive alt text",
  "asset": { "_type": "reference", "_ref": "image-<assetId>-<width>x<height>-<format>" }
}
```

To obtain a valid `_ref`, the binary must first be uploaded through Sanity's
asset pipeline — there is no way to fabricate a valid `_ref` string. The
codebase's own migration script does this via:

```ts
const asset = await client.assets.upload('image', buffer, { filename })
// asset._id is the value to put in `asset._ref`
```

(`migrate.ts`, using `@sanity/client`'s `.assets.upload()`.) An automation
must do the same — download/generate the image bytes, call
`writeClient.assets.upload('image', buffer, { filename })`, then reference
`asset._id`.

## Where images are stored

All uploaded assets live on Sanity's CDN under `cdn.sanity.io`, scoped to the
project's `projectId`/`dataset`. `next.config.ts` only allowlists
`cdn.sanity.io` in `images.remotePatterns` — any other remote image host will
be rejected by `next/image` at render time.

## How URLs are generated

`src/sanity/lib/image.ts` wraps `@sanity/image-url`:

```ts
const builder = createImageUrlBuilder({ projectId, dataset })
export const urlFor = (source) => builder.image(source)
```

Usage pattern seen in the codebase: `urlFor(image).width(1600).url()` (used
for in-content Portable Text images). For card/hero images, the GROQ
projections resolve the URL **server-side in the query itself** via
`mainImage.asset->url` / `coalesce(ogImage.asset->url, mainImage.asset->url)`
rather than calling `urlFor()` in React — so `PostCard`/`Post` types carry a
plain `imageUrl: string`, not a Sanity image object. `urlFor()` is only used
for the raw Portable Text `image` block type inside the article body (where
the full image object, not a flattened URL, is available).

## How `next/image` is used

- Blog card (`/blogs` index): `<Image fill className="object-cover" sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw" />` inside an `aspect-video` container.
- Post hero (`/blogs/[slug]`): `<Image fill priority sizes="(max-width: 768px) 100vw, 768px" />`, also `aspect-video`.
- Both use Sanity-resolved plain URLs (`imageUrl`), not `urlFor()`.
- **In-content Portable Text images use a plain `<img>` tag**, not
  `next/image` (see the `image` type handler in `[slug]/page.tsx` — it has an
  explicit `eslint-disable-next-line @next/next/no-img-element` comment).
  This is a deliberate exception, not an oversight, likely because Portable
  Text images can appear at arbitrary/unknown counts and dimensions inline in
  rich content.

## Responsive images

Handled via `next/image`'s `sizes` prop (breakpoint-aware `srcset` generation)
on card/hero images only. In-content images (`<img>`) are not responsive —
they render at whatever width `urlFor(image).width(1600).url()` returns,
scaled down by CSS (`h-auto w-full`).

## Featured image handling

`mainImage` → used in three places: blog card thumbnail, post-page hero, and
as the fallback source for `ogImage` (`coalesce(ogImage.asset->url,
mainImage.asset->url)` inside the GROQ query itself — the fallback logic is
server-side/query-side, not client JS).

## OG image mechanics

- Recommended real dimensions: **1200×630** (this exact width/height is
  hardcoded in the `openGraph.images` array in `generateMetadata`).
  Twitter reuses the same URL — no separate crop/field for Twitter.
- If neither `ogImage` nor `mainImage` is set, `ogImageUrl` is `undefined` and
  the `images` array is omitted entirely from both OG and Twitter metadata
  (falls back to the root layout's `/og-image.png` default via Next's
  metadata merging, assuming that file actually exists — see
  `recommended-improvements.md`).

## Alt text rules

- `mainImage.alt`, `ogImage.alt`, embedded content `image.alt`, and
  `author.image.alt` are all custom-validated: **required only when an asset
  is actually set** (a Sanity `rule.custom()` check inspecting
  `context.parent.asset`). An image field with no asset at all is fine to
  leave `alt` empty; an image field *with* an asset and no `alt` is a
  validation error.
