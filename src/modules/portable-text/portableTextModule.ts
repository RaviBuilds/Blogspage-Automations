/**
 * Portable Text Converter module (module 15, registry key `portable-text`).
 *
 * Converts the draft's constrained Markdown into Blogspage's exact Portable
 * Text subset, substituting already-resolved assets:
 * - `[[image: markerId]]` placeholders become `image` blocks backed by the
 *   human-attached/uploaded asset (`images.uploaded[].assetId`).
 * - `[[link: markerId]]` placeholders become `internalLink` annotations using
 *   `sanity.resolvedLinks` (produced by the Internal Link Generator).
 *
 * All structure is produced by the deterministic `markdown` +
 * `fromMarkdownAst` libraries; unresolved markers fail the run rather than
 * publishing an article with dangling placeholders.
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
  ImagesSectionSchema,
  ResolvedLinkSchema,
  type DraftSection,
  type ImagesSection,
  type PipelineState,
  type PortableTextBlock,
  type ResolvedLink,
} from '@/core/state.js';
import type {
  MarkdownBlock,
  MarkdownDocument,
  MarkdownInline,
  MarkdownParagraph,
} from '@/lib/markdown.js';
import { parseMarkdown } from '@/lib/markdown.js';
import { fromMarkdownAst, type PortableTextNode } from '@/lib/portableText/fromMarkdownAst.js';
import { assertValid } from '@/lib/schemaValidator.js';

import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMProvider } from '@/providers/llm/LLMProvider.js';

const PORTABLE_TEXT_MODULE_KEY = 'portable-text' as const;

/** Services injected by the composition root (uniform across the registry). */
export interface PortableTextModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

// ============================================================================
// Input Contract
// ============================================================================

export interface PortableTextRequest {
  readonly draft: DraftSection;
  readonly images?: ImagesSection | undefined;
  readonly resolvedLinks?: readonly ResolvedLink[] | undefined;
}

export const PortableTextRequestSchema: z.ZodType<PortableTextRequest> = z
  .object({
    draft: DraftSectionSchema,
    images: ImagesSectionSchema.optional(),
    resolvedLinks: z.array(ResolvedLinkSchema).optional(),
  })
  .strict();

// ============================================================================
// Output Contract
// ============================================================================

export interface PortableTextResult {
  readonly content: readonly PortableTextNode[];
}

/** Loose node schema: structure is fully validated by `fromMarkdownAst`/`validatePortableText`. */
const PortableTextNodeSchema: z.ZodType<PortableTextNode> = z
  .object({
    _type: z.string(),
    _key: z.string(),
  })
  .passthrough() as unknown as z.ZodType<PortableTextNode>;

export const PortableTextResultSchema: z.ZodType<PortableTextResult> = z
  .object({
    content: z.array(PortableTextNodeSchema),
  })
  .strict();

// ============================================================================
// Module Metadata
// ============================================================================

/** Immutable metadata exposed through ModuleRegistry discovery. */
// ============================================================================
// Module Factory and Registration
// ============================================================================

/** Creates an independently testable, registry-discoverable Portable Text module. */
export function createPortableTextModule(): PipelineModule<
  PortableTextRequest,
  PortableTextResult,
  PortableTextModuleServices
> {
  return defineModule({
    metadata: portableTextModuleMetadata,
    execute: executePortableText,
  });
}

/** Registers one Portable Text module without triggering execution. */
export function registerPortableTextModule(
  registry: ModuleRegistry<PortableTextModuleServices>,
  module: PipelineModule<
    PortableTextRequest,
    PortableTextResult,
    PortableTextModuleServices
  > = createPortableTextModule(),
): ModuleRegistry<PortableTextModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the Portable Text module. */
export function createPortableTextModuleBinding(): OrchestratorModuleBinding<PortableTextModuleServices> {
  return Object.freeze({
    key: PORTABLE_TEXT_MODULE_KEY,
    createInput: (state: PipelineState): PortableTextRequest => buildPortableTextRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => {
      const result = assertValid(PortableTextResultSchema, output, PORTABLE_TEXT_MODULE_KEY);
      return {
        ...state,
        sanity: {
          ...state.sanity,
          portableText: result.content as unknown as readonly PortableTextBlock[],
        },
      };
    },
  });
}

// ============================================================================
// Execution Implementation
// ============================================================================

/** Builds the module's input, requiring a draft. */
export function buildPortableTextRequest(state: PipelineState): PortableTextRequest {
  if (state.draft === undefined || state.draft.current === undefined) {
    throw new ValidationError(PORTABLE_TEXT_MODULE_KEY, [
      'state.draft.current is required to convert the article to Portable Text.',
    ]);
  }
  return {
    draft: state.draft,
    images: state.images,
    resolvedLinks: state.sanity?.resolvedLinks,
  };
}

function executePortableText(
  input: PortableTextRequest,
  _context: ModuleExecutionContext<PortableTextModuleServices>,
): PortableTextResult {
  const request = assertValid(PortableTextRequestSchema, input, PORTABLE_TEXT_MODULE_KEY);
  const content = buildPortableText(request);
  return deepFreeze({ content });
}

/**
 * Parses the draft markdown, substitutes resolved images + internal links,
 * converts to Portable Text, and runs the structural validator.
 *
 * @throws {ValidationError} When an image/link marker cannot be resolved or
 * the produced structure violates the Portable Text invariants.
 */
export function buildPortableText(request: PortableTextRequest): readonly PortableTextNode[] {
  const document = parseMarkdown(request.draft.current.markdown);
  const substituted = substituteMarkers(document, request);
  return fromMarkdownAst(substituted);
}

// ============================================================================
// Marker Substitution
// ============================================================================

function substituteMarkers(
  document: MarkdownDocument,
  request: PortableTextRequest,
): MarkdownDocument {
  const uploadByMarker = new Map<string, { assetId: string; altText: string }>();
  for (const upload of request.images?.uploaded ?? []) {
    if (upload.placementMarkerId === undefined) continue;
    uploadByMarker.set(upload.placementMarkerId, {
      assetId: upload.assetId,
      altText: upload.altText,
    });
  }

  const linkByMarker = new Map<string, ResolvedLink>();
  for (const link of request.resolvedLinks ?? []) {
    linkByMarker.set(link.markerId, link);
  }

  return {
    type: 'document',
    children: document.children.flatMap((block) => {
      if (block.type === 'paragraph') {
        return rewriteParagraph(block, uploadByMarker, linkByMarker);
      }
      if ('children' in block) {
        return [rewriteNonParagraph(block, linkByMarker)];
      }
      return [block];
    }),
  };
}

/** Rewrites link markers in blocks that never contain images (headings, lists…). */
function rewriteNonParagraph<T extends { readonly children: readonly MarkdownInline[] }>(
  block: T,
  linkByMarker: ReadonlyMap<string, ResolvedLink>,
): T {
  return {
    ...block,
    children: block.children.flatMap((node, _index) => {
      if (node.type !== 'linkMarker') return [node];
      const resolvedLink = linkByMarker.get(node.value);
      if (resolvedLink === undefined) return [];
      return [
        {
          type: 'internalLink',
          value: resolvedLink.anchorText,
          targetId: resolvedLink.targetPostId,
        },
      ];
    }),
  };
}

/**
 * Splits a paragraph around `[[image: markerId]]` nodes into text paragraphs
 * and image blocks, and resolves `[[link: markerId]]` placeholders.
 */
function rewriteParagraph(
  paragraph: MarkdownParagraph,
  uploadByMarker: ReadonlyMap<string, { assetId: string; altText: string }>,
  linkByMarker: ReadonlyMap<string, ResolvedLink>,
): MarkdownBlock[] {
  if (!paragraph.children.some((node) => node.type === 'imageMarker')) {
    return [rewriteNonParagraph(paragraph, linkByMarker)];
  }

  const blocks: MarkdownBlock[] = [];
  let currentText: MarkdownInline[] = [];

  const flushText = (): void => {
    const meaningful = currentText.filter(
      (node) => node.type !== 'text' || node.value.trim().length > 0,
    );
    if (meaningful.length > 0) {
      blocks.push({ type: 'paragraph', children: meaningful });
    }
    currentText = [];
  };

  for (const node of paragraph.children) {
    if (node.type === 'linkMarker') {
      const resolvedLink = linkByMarker.get(node.value);
      if (resolvedLink !== undefined) {
        currentText.push({
          type: 'internalLink',
          value: resolvedLink.anchorText,
          targetId: resolvedLink.targetPostId,
        });
      }
      continue;
    }

    if (node.type !== 'imageMarker') {
      currentText.push(node);
      continue;
    }

    const upload = uploadByMarker.get(node.value);
    if (upload === undefined) {
      throw new ValidationError(PORTABLE_TEXT_MODULE_KEY, [
        `Image marker "${node.value}" has no matching uploaded image. Attach it and resume, or re-run the image plan.`,
      ]);
    }

    flushText();
    blocks.push({
      type: 'image',
      alt: upload.altText,
      source: `sanity:${upload.assetId}`,
    });
  }

  flushText();
  if (blocks.length === 0) {
    throw new ValidationError(PORTABLE_TEXT_MODULE_KEY, [
      'Paragraph produced no content after marker substitution.',
    ]);
  }
  return blocks;
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
export const portableTextModuleMetadata: ModuleMetadata = Object.freeze({
  key: PORTABLE_TEXT_MODULE_KEY,
  displayName: 'Portable Text',
  description:
    'Converts the drafted Markdown into Blogspage Portable Text, substituting resolved images (images.uploaded) and internal links (sanity.resolvedLinks).',
  dependencies: Object.freeze(['internal-links', 'image-upload'] as const),
  capabilities: Object.freeze({
    requires: Object.freeze([
      'internal-links.resolved-links',
      'image-upload.uploaded-assets',
      'writer.draft',
    ]),
    provides: Object.freeze(['portable-text.portable-content']),
  }),
});
