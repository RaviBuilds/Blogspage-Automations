# Components Reference (blog-relevant + shared chrome)

## Blog-specific components (`src/components/blogs/`)

### `BlogFooterCTA.tsx` (client component)
- **Purpose:** renders an embedded `ctaBlock` from Portable Text as a centered
  conversion card at the end (or mid) of an article.
- **Props:** `headline: string`, `body: string`, `primaryLabel?: string`
  (default `"Talk to our AI"`), `secondaryLabel: string`,
  `secondaryHref: string`.
- **Relationships:** invoked from the `ctaBlock` type handler in
  `[slug]/page.tsx`'s `portableTextComponents.types.ctaBlock`. The parent
  guards rendering — only calls this component if `headline`, `body`,
  `secondaryLabel`, and `secondaryHref` are all truthy on the Portable Text
  value.
- **Render flow:** primary button dispatches `window.dispatchEvent(new
  Event("open-ai-chat"))` (opens the global `ChatWidget`, ignores any href
  entirely); secondary button is a plain `next/link` to `secondaryHref`.

### `CodeBlock.tsx` (async server component)
- **Purpose:** renders a `codeBlock` Portable Text object as syntax-highlighted
  code with a language badge and copy button.
- **Props:** `language?: string`, `code?: string`, `filename?: string`.
- **Relationships:** calls `highlightCode()`/`getBadgeLabel()` from
  `src/lib/highlight.ts` (Shiki), renders `<CopyButton code={code} />`.
- **Render flow:** returns `null` if `code` is falsy. Highlighting happens
  server-side (it's an `async` server component using `await
  highlightCode(...)`) — the highlighted HTML is injected via
  `dangerouslySetInnerHTML`.

### `CopyButton.tsx` (client component)
- **Purpose:** copy-to-clipboard button for `CodeBlock`.
- **Props:** `code: string`.
- **Behavior:** `navigator.clipboard.writeText`, with a manual `<textarea>` +
  `document.execCommand('copy')` fallback for environments without Clipboard
  API access. Shows "Copied!" for 2 seconds after a successful copy.

## Portable Text render pipeline (defined inline in `[slug]/page.tsx`)

Not extracted into a separate file — `portableTextComponents:
PortableTextComponents` is defined directly inside
`src/app/(site)/blogs/[slug]/page.tsx`:
- `types.ctaBlock` → `BlogFooterCTA` (see above).
- `types.image` → a plain `<figure><img/></figure>` (see `image-system.md` —
  deliberately not `next/image`), using `urlFor(image).width(1600).url()`.
- `types.codeBlock` → `CodeBlock`.
- `marks.link` → external anchor, `target="_blank"` unless
  `value.blank === false`, `rel` includes `noopener noreferrer` plus
  `nofollow` if `value.nofollow`.
- `marks.internalLink` → `next/link` to
  `/blogs/${value.reference.slug.current}`.

If you add a new embedded object type to `blockContentType.ts` in the future
(out of scope for automation to do, but relevant context), a matching entry
must be added to this `portableTextComponents` map or it silently fails to
render.

## Shared chrome (`src/components/layout/`)

### `Navbar.tsx` (client component)
Floating pill nav, hides on scroll-down past 100px (Framer Motion +
`useScroll`/`useMotionValueEvent`). Links: Home, `/#services`, `/#process`,
`/blogs`. "Start a Project" button dispatches the same `open-ai-chat` event
used by `BlogFooterCTA`.

### `Footer.tsx` (client component)
Static link columns (Solutions/Company/Legal — includes a `/blogs` link under
"Company"), social links, brand blurb. Not otherwise interactive with blog
data.

## Global widgets (`src/components/`)

### `ChatWidget` (`chat-widget.tsx`, client component, default export)
- Mounted once in `(site)/layout.tsx`. Uses `@ai-sdk/react`'s `useChat()`
  against `/api/chat`.
- Listens globally for `"open-ai-chat"` to open itself — this is the
  integration point every "Talk to our AI" / CTA button relies on.
- Renders a welcome message, 4 quick-reply buttons, the message thread, a
  "lead captured" success indicator (derived by scanning
  `messages[].parts` for a completed `tool-save_lead` call with
  `output.success === true`), and an input form.

### `Preloader`, `CustomCursor`, `SmoothScrollProvider` (ui/providers)
Purely cosmetic/UX chrome (loading screen, custom cursor, Lenis-based smooth
scroll). Not relevant to content/automation, listed for completeness since
they wrap every `(site)` page.

## Homepage blog surface

### `latest-blogs.tsx` (`src/components/home/`, server component)
Fetches `LATEST_POSTS_QUERY` (newest 3 posts) and renders a card grid with a
"View all articles" link to `/blogs`. Returns `null` entirely if there are
zero posts (no empty-state UI on the homepage, unlike `/blogs` which shows an
empty-state message).

## Solution-page components (`src/components/solutions/`)

Not blog-related, but part of the same site: `SolutionTemplate` (generic
per-niche landing page), `GymSolutionLanding` (bespoke override for the gym
vertical), `SolutionHero`, `FadeUp` (scroll-reveal wrapper), and
`hotel-hyderabad-landing.tsx` (an apparent one-off/legacy landing variant not
wired into the current niche-driven routing — worth flagging in
`recommended-improvements.md` as possibly dead code, pending confirmation).
