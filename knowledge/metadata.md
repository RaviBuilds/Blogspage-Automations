# Metadata Reference

This document is a compact field-by-field reference for every metadata surface
in the app. See `seo-system.md` for the narrative explanation.

## Root defaults (`src/app/layout.tsx`)

```ts
metadataBase: new URL("https://blogspage.com")
title: { default: "Blogspage | AI Automation & SaaS Agency", template: "%s | Blogspage" }
description: "Blogspage builds production-grade SaaS, digital systems, and AI workflows for ambitious founders. We turn bold product ideas into scalable, revenue-ready platforms."
keywords: ["SaaS agency", "AI automation", "digital systems", "AI workflows", "product engineering", "web development"]
openGraph: { type: "website", locale: "en_US", url: "https://blogspage.com", siteName: "Blogspage", images: [{ url: "/og-image.png", width: 1200, height: 630 }] }
twitter: { card: "summary_large_image", images: ["/og-image.png"] }
```

Every page's `<title>` is composed through the `template` unless a page
explicitly sets its own full title without inheriting the template (Next.js
metadata merges by default, so most pages just set a page-specific `title`
string and get `"{title} | Blogspage"`).

Note: `/og-image.png` is referenced as the default OG image but was **not**
found in `public/` during this audit (only `blogspage-logo.png`, favicon, and
a handful of case-study/placeholder images exist there) — see
`recommended-improvements.md`.

## `/blogs` (index) — static `metadata` export

```ts
title: "Insights & Engineering"
description: "Technical deep-dives, web architecture, and field notes on building high-conversion business platforms."
alternates: { canonical: "https://blogspage.com/blogs" }
```

## `/blogs/[slug]` — `generateMetadata()`

See `seo-system.md` table. Key resolvers, all in `src/lib/blog.ts`:
- `resolveDescription(post)` — `metaDescription || excerpt || fallback sentence`, HTML-entity-decoded.
- `decodeHtmlEntities(text)` — un-escapes `&amp; &lt; &gt; &quot; &#39;` before any title/description is emitted (write literal characters, not entities, when authoring).
- `postUrl(slug)` — `${SITE_URL}/blogs/${slug}`, `SITE_URL = "https://blogspage.com"`.

## `/solutions/[slug]` — `generateMetadata()`

```ts
title: `${niche.title} Business Solution Website in ${cityLabel} | Blogspage`
description: `${niche.hero.subhead} ${niche.seoLabel}`
alternates: { canonical: `${SITE_URL}/solutions/${slug}` }
openGraph: { title, description, url: canonical, siteName: "Blogspage", type: "website" }
```

No Twitter card override on solution pages (inherits root default).

## JSON-LD emitted per surface

| Route | JSON-LD types |
| --- | --- |
| `/blogs/[slug]` | `BlogPosting`, `BreadcrumbList`, `FAQPage` (conditional) |
| `/solutions/[slug]` | `ProfessionalService` |

Builders for the blog ones live in `src/lib/blog.ts`
(`buildArticleJsonLd`, `buildBreadcrumbJsonLd`, `buildFaqJsonLd`); the
`ProfessionalService` object is built inline in
`src/app/(site)/solutions/[slug]/page.tsx` (not extracted to a shared helper).

## Site-wide constants

- `SITE_URL` / `BASE_URL` = `"https://blogspage.com"` — **duplicated as a
  literal string** in `src/lib/blog.ts`, `src/app/sitemap.ts`,
  `src/app/robots.ts`, and `src/app/(site)/solutions/[slug]/page.tsx` rather
  than imported from one shared constant. `SITE_NAME = "Blogspage"` is also
  defined in `src/lib/blog.ts` only. Any automation that needs the canonical
  site URL should hardcode `https://blogspage.com` to match, but be aware this
  is a repo-wide duplication (see `recommended-improvements.md`).
