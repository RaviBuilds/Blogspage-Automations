# Routing

## Route map

| URL | File | Type |
| --- | --- | --- |
| `/` | `src/app/(site)/page.tsx` | Homepage (server component, composes home/* sections) |
| `/blogs` | `src/app/(site)/blogs/page.tsx` | Blog index, `revalidate = 300` |
| `/blogs/[slug]` | `src/app/(site)/blogs/[slug]/page.tsx` | Single post, `revalidate = 3600`, `generateStaticParams` |
| `/contact` | `src/app/(site)/contact/page.tsx` | Contact form page |
| `/solutions/[slug]` | `src/app/(site)/solutions/[slug]/page.tsx` | Programmatic vertical+city landing page, fully static |
| `/privacy` | `src/app/(site)/privacy/page.tsx` | Static legal page |
| `/terms` | `src/app/(site)/terms/page.tsx` | Static legal page |
| `/studio/*` | `src/app/studio/[[...tool]]/page.tsx` | Embedded Sanity Studio (catch-all) |
| `/api/chat` | `src/app/api/chat/route.ts` | POST-only streaming AI chat endpoint |
| `/sitemap.xml` | `src/app/sitemap.ts` | Next.js metadata route convention |
| `/robots.txt` | `src/app/robots.ts` | Next.js metadata route convention |

Server Action (not a route, but a mutation entry point):
`src/app/actions/leads.ts` → `submitLead()`, used by the homepage contact
form via `useActionState`.

## Route groups & layouts

- `(site)` is a route group — segment name in parens, excluded from the URL.
  Its `layout.tsx` wraps every page above with `Navbar`, `Footer`,
  `ChatWidget`, `Preloader`, `SmoothScrollProvider`, `CustomCursor`.
- `studio` is a real segment (`/studio`), with its own separate `layout.tsx`
  that renders none of the site chrome — just the Studio UI.
- Root `layout.tsx` (`src/app/layout.tsx`) wraps everything: fonts, root
  `<html className="dark">`, global metadata defaults, `<Analytics />`.

## Dynamic route params are Promises (Next.js 15 convention)

Both `[slug]` pages type their `params` as `Promise<{ slug: string }>` and
`await params` inside the function body — this is the Next.js 15 async
`params`/`searchParams` convention, not a project-specific quirk. Any new
dynamic route added by automation-adjacent tooling in this codebase (were one
ever added) must follow the same pattern.

## Legacy URL redirects (`next.config.ts`)

```
/blog          → /blogs           (permanent)
/blog/:slug    → /blogs/:slug      (permanent)
/:slug         → /blogs/:slug      (permanent, catch-all with exclusions)
```

The catch-all regex excludes reserved segments (`blogs`, `studio`,
`solutions`, `contact`, `privacy`, `terms`, `api`, `_next`, `favicon.ico`,
`robots.txt`, `sitemap.xml`) and any path ending in a static file extension
(images, fonts, JS/CSS/JSON/etc.) so that `/public` assets and framework
internals are never redirected. This exists to preserve link equity from a
prior WordPress site whose posts lived at the domain root
(`blogspage.com/post-slug`) rather than under `/blogs/`.

## `/solutions/[slug]` routing contract

`generateStaticParams()` calls `allNicheParams()` (from `niches.ts`), which
returns one param per niche for `DEFAULT_CITY` only (`hyderabad`) — i.e. 10
static solution pages total, not one per (niche × city) combination, since no
other cities are enumerated anywhere. The page component special-cases one
niche (`gym-fitness`) to render a bespoke component
(`GymSolutionLanding`) instead of the generic `SolutionTemplate` — everything
else renders through the shared template. See `components.md`.

## Chat widget as cross-cutting UI, not a route

The AI chat widget is mounted globally in `(site)/layout.tsx` (so it's present
on every `(site)` page, but not on `/studio`). It listens for a global
`window` event `"open-ai-chat"`, dispatched by the navbar's "Start a Project"
button and by `BlogFooterCTA`'s primary button — this is how blog CTAs open
the same chat instance instead of navigating anywhere.
