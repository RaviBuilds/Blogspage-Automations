# API Surface

Blogspage Agency exposes very little HTTP API surface of its own — most
"backend" logic is either a Server Action or a direct Sanity write from
server components. There is **no public content-authoring API** — automation
must write to Sanity directly (see `automation-integration.md`), not to any
endpoint on the Blogspage Agency Next.js app.

## `POST /api/chat` (`src/app/api/chat/route.ts`)

- **Purpose:** streaming chat endpoint powering the "Sweety" AI sales widget.
  Not a content/blog API.
- **Auth:** none (public endpoint). Requires `NVIDIA_API_KEY` server-side; if
  missing, returns `500 { error: "Server is not configured for chat." }`.
- **Request body:** `{ messages: UIMessage[] }` (Vercel AI SDK `UIMessage`
  shape). Returns `400` if `messages` is missing or not an array.
- **Response:** a streamed UI-message response
  (`result.toUIMessageStreamResponse(...)`), consumed by `@ai-sdk/react`'s
  `useChat()` on the client. `dynamic = "force-dynamic"` (never statically
  optimized/cached).
- **Model:** NVIDIA's OpenAI-compatible endpoint
  (`https://integrate.api.nvidia.com/v1`), model id
  `"meta/llama-3.3-70b-instruct"`.
- **Tool:** exposes exactly one tool, `save_lead`, Zod-validated
  (`.strict()`), which calls `recordLead()` from `src/lib/lead-store.ts`. See
  `architecture.md` for the full anti-hallucination prompt design.
- **Relevance to automation:** none directly — this endpoint is the sales
  chatbot, not a content-publishing API. Listed for completeness since it's
  the only API route in the app.

## Server Action: `submitLead` (`src/app/actions/leads.ts`)

- **Not an HTTP endpoint** — a Next.js Server Action (`"use server"`),
  invoked directly from the homepage contact form via `useActionState`.
- Validates `name`/`email`/`message` server-side, then calls the same
  `recordLead()` used by the chat tool.
- Irrelevant to blog automation; listed for completeness.

## Sanity's own HTTP API (what automation actually talks to)

Not part of the Blogspage Agency app's code, but the **actual integration
surface** for automation: Sanity's standard Content Lake HTTP API, accessed
via the `@sanity/client` (or `next-sanity`, which wraps it) SDK, using the
same `projectId`/`dataset`/`apiVersion` as the main app and a
`SANITY_WRITE_TOKEN` with write permission (see `environment.md` and
`automation-integration.md`). This is a **mutation API** (`client.create`,
`client.createOrReplace`, `client.patch`, `client.assets.upload`, transactions
via `client.transaction()`) — there is no bespoke REST/GraphQL layer of
Blogspage Agency's own in front of it.

## No webhook endpoints

No webhook receiver route (e.g. `/api/revalidate`, `/api/webhooks/sanity`) was
found. Content changes are picked up purely through Next.js ISR
(`revalidate` intervals) and the Sanity CDN's own propagation — there is no
on-demand revalidation hook for automation to call after publishing new
content. See `recommended-improvements.md` for the implication (new/updated
posts can take up to the full `revalidate` window — up to 1 hour for a single
post — to appear live).
