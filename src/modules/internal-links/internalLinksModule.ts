/**
 * Internal Link Generator module (module 16, registry key `internal-links`).
 *
 * Resolves the draft's `[[link: markerId]]` placeholders to real post IDs by
 * matching `seo.internalLinkTargets` (candidate title/slug) against existing
 * posts through an injected post lookup. The result (`sanity.resolvedLinks`)
 * is consumed by the Portable Text converter, whose `internalLink`
 * annotations need real `reference._ref` values.
 */

import { z } from 'zod';

import { ValidationError } from '@/core/errors.js';
import {
  defineModule,
  type ModuleExecutionContext,
  type ModuleMetadata,
  type ModuleRegistry,
  type PipelineModule,
} from '@/core/moduleRunner.js';
import type { OrchestratorModuleBinding } from '@/core/orchestrator.js';
import {
  DraftSectionSchema,
  ResolvedLinkSchema,
  SeoSectionSchema,
  type DraftSection,
  type PipelineState,
  type ResolvedLink,
  type SeoSection,
} from '@/core/state.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMProvider } from '@/providers/llm/LLMProvider.js';

const INTERNAL_LINKS_MODULE_KEY = 'internal-links' as const;

/** The minimal read boundary the module needs to resolve a target post. */
export interface PostLookup {
  /** Resolves an existing post id by its slug, or null when the post is unknown. */
  findPostIdBySlug(slug: string): Promise<string | null>;
}

/** Services injected by the composition root. */
export interface InternalLinksModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
  /** Resolves candidate slugs to real post ids (absent -> no links resolved). */
  readonly postLookup?: PostLookup | undefined;
}

// ============================================================================
// Input Contract
// ============================================================================

export interface InternalLinksRequest {
  readonly seo: SeoSection;
  readonly draft: DraftSection;
}

export const InternalLinksRequestSchema: z.ZodType<InternalLinksRequest> = z
  .object({
    seo: SeoSectionSchema,
    draft: DraftSectionSchema,
  })
  .strict();

// ============================================================================
// Output Contract
// ============================================================================

export interface InternalLinksResult {
  readonly resolvedLinks: readonly ResolvedLink[];
}

export const InternalLinksResultSchema: z.ZodType<InternalLinksResult> = z
  .object({
    resolvedLinks: z.array(ResolvedLinkSchema),
  })
  .strict();

// ============================================================================
// Module Metadata
// ============================================================================

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const internalLinksModuleMetadata: ModuleMetadata = Object.freeze({
  key: INTERNAL_LINKS_MODULE_KEY,
  displayName: 'Internal Links',
  description:
    'Resolves the draft internal-link markers to real post ids via the SEO target set and an injected post lookup, writing sanity.resolvedLinks.',
  dependencies: Object.freeze(['seo-planner', 'writer', 'humanizer'] as const),
  capabilities: Object.freeze({
    requires: Object.freeze([
      'seo.internal-link-targets',
      'writer.draft',
      'humanizer.humanized-draft',
    ]),
    provides: Object.freeze(['internal-links.resolved-links']),
  }),
});

// ============================================================================
// Module Factory and Registration
// ============================================================================

/** Creates an independently testable, registry-discoverable Internal Links module. */
export function createInternalLinksModule(): PipelineModule<
  InternalLinksRequest,
  InternalLinksResult,
  InternalLinksModuleServices
> {
  return defineModule({
    metadata: internalLinksModuleMetadata,
    execute: executeInternalLinks,
  });
}

/** Registers one Internal Links module without triggering execution. */
export function registerInternalLinksModule(
  registry: ModuleRegistry<InternalLinksModuleServices>,
  module: PipelineModule<
    InternalLinksRequest,
    InternalLinksResult,
    InternalLinksModuleServices
  > = createInternalLinksModule(),
): ModuleRegistry<InternalLinksModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the Internal Links module. */
export function createInternalLinksModuleBinding(): OrchestratorModuleBinding<InternalLinksModuleServices> {
  return Object.freeze({
    key: INTERNAL_LINKS_MODULE_KEY,
    createInput: (state: PipelineState): InternalLinksRequest => buildInternalLinksRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => {
      const result = assertValid(InternalLinksResultSchema, output, INTERNAL_LINKS_MODULE_KEY);
      return {
        ...state,
        sanity: {
          ...state.sanity,
          resolvedLinks: result.resolvedLinks,
        },
      };
    },
  });
}

// ============================================================================
// Execution Implementation
// ============================================================================

/** Builds the module's input, requiring seo + draft. */
export function buildInternalLinksRequest(state: PipelineState): InternalLinksRequest {
  if (state.seo === undefined) {
    throw new ValidationError(INTERNAL_LINKS_MODULE_KEY, [
      'state.seo is required to resolve internal link targets.',
    ]);
  }
  if (state.draft === undefined || state.draft.current === undefined) {
    throw new ValidationError(INTERNAL_LINKS_MODULE_KEY, [
      'state.draft.current is required to resolve internal link markers.',
    ]);
  }
  return { seo: state.seo, draft: state.draft };
}

async function executeInternalLinks(
  input: InternalLinksRequest,
  context: ModuleExecutionContext<InternalLinksModuleServices>,
): Promise<InternalLinksResult> {
  const request = assertValid(InternalLinksRequestSchema, input, INTERNAL_LINKS_MODULE_KEY);
  if (context.services.postLookup === undefined) {
    return deepFreeze({ resolvedLinks: Object.freeze([]) });
  }
  const resolvedLinks = await resolveInternalLinks(request, context.services.postLookup);
  return deepFreeze({ resolvedLinks });
}

/**
 * Matches every draft link marker to a resolved post. A marker resolves when
 * its title hint equals a target's candidate title, or when its hint matches
 * a target's candidate slug. Unresolved markers are skipped (the converter
 * then drops them to plain text).
 */
export async function resolveInternalLinks(
  request: InternalLinksRequest,
  lookup: PostLookup,
): Promise<readonly ResolvedLink[]> {
  const resolved: ResolvedLink[] = [];

  for (const marker of request.draft.current.linkMarkers) {
    const target = findTargetForMarker(marker, request.seo.internalLinkTargets);
    if (target === undefined) {
      continue;
    }

    const targetPostId = await lookup.findPostIdBySlug(target.candidateSlug);
    if (targetPostId === null) {
      continue;
    }

    resolved.push(
      Object.freeze({
        markerId: marker.markerId,
        targetPostId,
        targetSlug: target.candidateSlug,
        anchorText: marker.anchorTextHint.trim() || target.candidateTitle,
      }),
    );
  }

  return Object.freeze(resolved);
}

function findTargetForMarker(
  marker: { readonly markerId: string; readonly anchorTextHint: string },
  targets: readonly {
    readonly candidateSlug: string;
    readonly candidateTitle: string;
    readonly relevance: 'high' | 'medium';
  }[],
):
  | {
      readonly candidateSlug: string;
      readonly candidateTitle: string;
      readonly relevance: 'high' | 'medium';
    }
  | undefined {
  const hint = marker.anchorTextHint.trim().toLowerCase();
  if (hint.length === 0) return undefined;

  return (
    targets.find((target) => target.candidateTitle.trim().toLowerCase() === hint) ??
    targets.find((target) => target.candidateSlug.trim().toLowerCase() === hint) ??
    targets.find(
      (target) =>
        hint.includes(target.candidateSlug.toLowerCase()) ||
        target.candidateSlug.toLowerCase().includes(hint),
    )
  );
}

// ============================================================================
// Internal Helpers
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item: unknown) => deepFreeze(item))) as T;
  }
  if (isRecord(value)) {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepFreeze(item)])),
    ) as T;
  }
  return value;
}
