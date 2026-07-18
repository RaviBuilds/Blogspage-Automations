# Environment Variables

Source: `.env.local` in `Blogspage Agency/` (keys enumerated below; **values
were not read or copied** — this audit only inspected variable names, per the
read-only/no-secrets-handling constraint).

| Variable | Consumed by | Purpose | Required? |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SANITY_PROJECT_ID` | `src/sanity/env.ts` (`assertValue`) | Sanity project ID | **Yes** — throws at import time if unset |
| `NEXT_PUBLIC_SANITY_DATASET` | `src/sanity/env.ts` (`assertValue`) | Sanity dataset name (e.g. `production`) | **Yes** — throws at import time if unset |
| `NEXT_PUBLIC_SANITY_API_VERSION` | `src/sanity/env.ts` | Sanity API version string | No — defaults to `'2026-06-14'` |
| `SANITY_WRITE_TOKEN` | `src/sanity/lib/write-client.ts`, `src/lib/lead-store.ts`, and all root-level one-off scripts (`migrate.ts`, `seed-meta.ts`, `sanitize-data.ts`, `diagnose-and-fix.ts`, `backfill-blog-meta.ts`) | Server-only Sanity write auth token | Required for any write path; its absence is handled *gracefully* in `lead-store.ts` (logs instead of throwing) but *fatally* in the one-off scripts (`throw new Error(...)`) |
| `WP_API_URL` | `migrate.ts` | Source WordPress API URL for the one-time content migration | Only needed to re-run the migration; irrelevant to steady-state operation |
| `NVIDIA_API_KEY` | `src/app/api/chat/route.ts` | Auth for NVIDIA's OpenAI-compatible chat completions endpoint (powers "Sweety") | Required for the chat feature only; unrelated to blog automation |

## Naming convention notes

- Anything prefixed `NEXT_PUBLIC_` is exposed to the browser bundle by
  Next.js's build-time inlining — by convention only genuinely public values
  (project ID, dataset name — not secrets) use this prefix here.
  `SANITY_WRITE_TOKEN` and `NVIDIA_API_KEY` are deliberately **not** prefixed,
  and `write-client.ts` additionally imports `"server-only"` as a build-time
  guard so it cannot accidentally be bundled into client code.

## Implication for `Blogspage Automations`

The automation project is a **separate Node/TypeScript project** and does not
inherit or import Blogspage Agency's `.env.local`. It needs its **own** copy
of at minimum:
- `NEXT_PUBLIC_SANITY_PROJECT_ID` (or an equivalently-named var in its own
  `.env`) — same value as the website's, since it must write into the same
  Sanity project/dataset.
- The dataset name (same value as the website's).
- A Sanity **write** token with `create`/`update` permission on that dataset
  (can be the same token as `SANITY_WRITE_TOKEN` or a separate one scoped to
  the automation — a separate token is preferable for auditability/rotation,
  but that's a decision for the user, not something to assume).
- Whatever LLM/image-generation provider keys the automation itself uses to
  *generate* content (out of scope of this audit — those don't exist yet in
  Blogspage Agency).

No values were read from `.env.local` beyond variable names, and no secrets
should be copied between the two projects' env files without the user's
explicit action.
