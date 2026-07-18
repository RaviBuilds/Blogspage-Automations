# Recommended Improvements (documentation only — NOT implemented)

Per instructions, Blogspage Agency is read-only. Everything below is a
recommendation for the user to review and approve separately. Nothing here
has been applied.

---

### 1. `BLOGSPAGE_AI_CONTEXT.md` is stale relative to the current schema

- **Reason:** it predates fields like `excerpt` (now hard-required),
  `evergreen`, `lastReviewed`, `faq`, `relatedPosts`, `focusKeyword`,
  `canonicalUrl`, `noindex`/`nofollow`, `ogTitle`/`ogDescription`, and the
  `internalLink` annotation. It also states `metaDescription` is hard-required
  (it's now a warning-only field) and lists ISR at 60s (actual: 300s index /
  3600s post).
- **Benefit:** any human or AI reading only that file would author posts
  missing the one field that's actually hard-required (`excerpt`) and would
  under-use the richer SEO/structured-data fields now available.
- **Priority:** Medium — it's an authoring aid, not runtime code, but it's
  actively misleading.
- **Affected files:** `BLOGSPAGE_AI_CONTEXT.md`.

### 2. `next-sanity`'s Live Content API is wired up but never mounted

- **Reason:** `src/sanity/lib/live.ts` defines `sanityFetch`/`SanityLive`, but
  no layout renders `<SanityLive />`, and no page uses `sanityFetch` in place
  of the plain `client.fetch`. The scaffolding exists but has zero effect.
- **Benefit:** if enabled, Studio edits could reflect on the live site near-
  instantly instead of waiting for the ISR window (up to 1 hour for a single
  post) — directly relevant to automation, since a freshly-published
  automated post currently has no fast path to appear live.
- **Priority:** Medium — directly affects how automation-published content
  propagates.
- **Affected files:** `src/app/layout.tsx` (or `(site)/layout.tsx`) to mount
  `<SanityLive />`; `src/app/(site)/blogs/page.tsx` and
  `src/app/(site)/blogs/[slug]/page.tsx` to switch from `client.fetch` to
  `sanityFetch`.

### 3. No on-demand revalidation / webhook endpoint

- **Reason:** there's no `/api/revalidate` (or similar) route, so the only way
  new/updated content becomes visible is waiting out the ISR interval (5 min
  for the index, 1 hour for an individual post) or a full redeploy.
- **Benefit:** an automation pipeline that just published a post could call a
  webhook to force-refresh the affected paths immediately instead of waiting
  up to an hour, which matters a lot for an automation-driven publishing
  cadence.
- **Priority:** High for automation's purposes specifically — this is the
  single biggest latency gap between "automation published a post" and "post
  is live."
- **Affected files:** new `src/app/api/revalidate/route.ts` calling Next's
  `revalidatePath`/`revalidateTag`, likely triggered by a Sanity webhook.

### 4. `/solutions/*` pages are excluded from `sitemap.ts`

- **Reason:** `sitemap.ts` only enumerates static routes + blog posts; none of
  the 10 programmatic solution pages appear.
- **Benefit:** those pages are clearly built for SEO (they carry
  `ProfessionalService` JSON-LD, local-SEO-optimized slugs, and dedicated
  metadata) but are invisible to sitemap-driven crawling.
- **Priority:** Medium.
- **Affected files:** `src/app/sitemap.ts`, `src/lib/niches.ts`
  (`allNicheParams`/`NICHES` are already exactly what's needed to build the
  entries).

### 5. Default OG image (`/og-image.png`) referenced but not found in `public/`

- **Reason:** `src/app/layout.tsx` sets `openGraph.images: [{ url:
  "/og-image.png", ... }]` and the equivalent for Twitter, but this audit did
  not find `og-image.png` anywhere under `public/`. If genuinely absent, every
  page without its own OG image override (any post lacking both `ogImage` and
  `mainImage`, and any non-blog page) will produce a broken social preview
  image.
- **Benefit:** fixing this restores social preview cards site-wide for the
  fallback case.
- **Priority:** Medium — worth a quick manual check to confirm the file
  really is missing (it may exist and simply not have been enumerated by this
  read-only pass, e.g. if it was added after the directory listing was taken).
- **Affected files:** `public/og-image.png` (add if missing).

### 6. `SITE_URL`/`BASE_URL` literal is duplicated across 4+ files

- **Reason:** `"https://blogspage.com"` is hardcoded separately in
  `src/lib/blog.ts`, `src/app/sitemap.ts`, `src/app/robots.ts`, and
  `src/app/(site)/solutions/[slug]/page.tsx`, instead of being imported from
  one shared constant.
- **Benefit:** a future domain change or staging-environment override
  requires editing 4+ files instead of 1; a shared `SITE_URL` constant
  (exported from, e.g., `src/lib/constants.ts`) would remove that risk.
- **Priority:** Low — cosmetic/maintainability, no functional bug today.
- **Affected files:** `src/lib/blog.ts`, `src/app/sitemap.ts`,
  `src/app/robots.ts`, `src/app/(site)/solutions/[slug]/page.tsx`.

### 7. No RSS feed

- **Reason:** confirmed no `feed.xml`/`rss.xml` route exists anywhere in
  `src/app`.
- **Benefit:** an RSS feed is low-effort with the existing `POSTS_QUERY` data
  and is a natural distribution channel for a content-marketing blog audience
  (and for other tools/aggregators to detect new automated content).
- **Priority:** Low — nice-to-have, not currently blocking anything.
- **Affected files:** new `src/app/rss.xml/route.ts` (or `feed.xml`).

### 8. `hotel-hyderabad-landing.tsx` looks like potentially dead/legacy code

- **Reason:** `src/components/solutions/hotel-hyderabad-landing.tsx` exists
  alongside the current niche-driven routing (`SolutionTemplate` +
  `GymSolutionLanding`), but `[slug]/page.tsx`'s routing logic only ever
  renders `GymSolutionLanding` or `SolutionTemplate` — this component was not
  observed to be imported/used anywhere in the traced render paths.
- **Benefit:** confirming and removing genuinely dead code reduces maintenance
  surface; if it's actually still wired in somewhere this audit didn't trace,
  no action needed.
- **Priority:** Low — cosmetic, needs a targeted grep/confirmation before any
  action (not performed here, since no code changes were made under the
  read-only constraint).
- **Affected files:** `src/components/solutions/hotel-hyderabad-landing.tsx`.

### 9. No programmatic uniqueness check for slugs outside Studio

- **Reason:** Studio's `defaultIsUnique` validator only runs inside the
  Studio UI. A raw API `client.create()` call (which is exactly what
  automation will do) has no server-side guard against creating two `post`
  documents with the same `slug.current`.
- **Benefit:** if automation (or any future script) ever races or double-runs,
  duplicate slugs could silently create two documents resolving to the same
  URL, with GROQ's `[0]` single-result queries picking one nondeterministically.
- **Priority:** Medium for automation's reliability specifically.
- **Affected files:** none in Blogspage Agency itself — this is really a
  requirement automation must self-enforce (documented already in
  `automation-integration.md` and `slug-system.md`), listed here in case the
  user wants a belt-and-suspenders schema-level fix (e.g. a Sanity document-
  level unique constraint via a custom validation function, which Sanity
  supports for slugs across the whole dataset, not just within Studio).
