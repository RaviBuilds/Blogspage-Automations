import { ValidationError } from '@/core/errors.js';
import type { MarkdownBlock, MarkdownDocument, MarkdownInline } from '@/lib/markdown.js';
import { validatePortableText } from '@/lib/portableText/validatePortableText.js';

/** A Sanity-compatible Portable Text span. */
export interface PortableTextSpan {
  readonly _type: 'span';
  readonly _key: string;
  readonly text: string;
  readonly marks: readonly string[];
}

/** A supported Portable Text annotation. */
export type PortableTextMarkDef =
  | {
      readonly _key: string;
      readonly _type: 'link';
      readonly href: string;
      readonly blank: boolean;
      readonly nofollow: boolean;
    }
  | {
      readonly _key: string;
      readonly _type: 'internalLink';
      readonly reference: { readonly _type: 'reference'; readonly _ref: string };
    };

/** A standard Portable Text block. */
export interface PortableTextBlock {
  readonly _type: 'block';
  readonly _key: string;
  readonly style: 'normal' | 'h2' | 'h3' | 'h4' | 'blockquote';
  readonly listItem?: 'bullet' | 'number';
  readonly level?: number;
  readonly children: readonly PortableTextSpan[];
  readonly markDefs: readonly PortableTextMarkDef[];
}

/** An uploaded-image Portable Text block. */
export interface PortableTextImage {
  readonly _type: 'image';
  readonly _key: string;
  readonly alt: string;
  readonly asset: { readonly _type: 'reference'; readonly _ref: string };
  readonly caption?: string;
}

/** A code block matching Blogspage's documented schema. */
export interface PortableTextCodeBlock {
  readonly _type: 'codeBlock';
  readonly _key: string;
  readonly language:
    | 'text'
    | 'typescript'
    | 'javascript'
    | 'tsx'
    | 'json'
    | 'bash'
    | 'css'
    | 'html'
    | 'groq'
    | 'sql';
  readonly filename?: string;
  readonly code: string;
}

/** A CTA block matching Blogspage's documented schema. */
export interface PortableTextCtaBlock {
  readonly _type: 'ctaBlock';
  readonly _key: string;
  readonly headline: string;
  readonly body: string;
  readonly primaryLabel: string;
  readonly secondaryLabel: string;
  readonly secondaryHref: string;
}

/** Every Portable Text block the deterministic converter can produce. */
export type PortableTextNode =
  | PortableTextBlock
  | PortableTextImage
  | PortableTextCodeBlock
  | PortableTextCtaBlock;

const CODE_LANGUAGES = new Set<PortableTextCodeBlock['language']>([
  'text',
  'typescript',
  'javascript',
  'tsx',
  'json',
  'bash',
  'css',
  'html',
  'groq',
  'sql',
]);

/**
 * Converts the constrained Markdown AST into Blogspage's exact Portable Text
 * subset. Links and images must already be resolved to real IDs in the AST:
 * `internal:<postId>` for internal links and `sanity:<assetId>` for images.
 *
 * @throws {ValidationError} When the AST still contains unresolved writer
 * markers or a reference/code language cannot be represented safely.
 */
export function fromMarkdownAst(document: MarkdownDocument): readonly PortableTextNode[] {
  const nodes = document.children.map((block, index) => convertBlock(block, index));
  validatePortableText(nodes);
  return nodes;
}

function convertBlock(block: MarkdownBlock, index: number): PortableTextNode {
  const key = `b${String(index + 1)}`;

  switch (block.type) {
    case 'heading':
      return createTextBlock(
        key,
        `h${String(block.level)}` as PortableTextBlock['style'],
        block.children,
      );
    case 'paragraph':
      return createTextBlock(key, 'normal', block.children);
    case 'blockquote':
      return createTextBlock(key, 'blockquote', block.children);
    case 'listItem':
      return {
        ...createTextBlock(key, 'normal', block.children),
        listItem: block.ordered ? 'number' : 'bullet',
        level: block.level,
      };
    case 'codeBlock': {
      const language = CODE_LANGUAGES.has(block.language as PortableTextCodeBlock['language'])
        ? (block.language as PortableTextCodeBlock['language'])
        : 'text';
      return {
        _type: 'codeBlock',
        _key: key,
        language,
        ...(block.filename === undefined ? {} : { filename: block.filename }),
        code: block.code,
      };
    }
    case 'image': {
      const assetId = extractSanityReference(block.source, 'image');
      if (block.alt.trim().length === 0) {
        throw new ValidationError('portable-text', ['Image alt text must be non-empty.']);
      }
      return {
        _type: 'image',
        _key: key,
        alt: block.alt,
        asset: { _type: 'reference', _ref: assetId },
        ...(block.caption === undefined ? {} : { caption: block.caption }),
      };
    }
    case 'cta':
      return {
        _type: 'ctaBlock',
        _key: key,
        headline: block.headline,
        body: block.body,
        primaryLabel: block.primaryLabel,
        secondaryLabel: block.secondaryLabel,
        secondaryHref: block.secondaryHref,
      };
  }
}

function createTextBlock(
  key: string,
  style: PortableTextBlock['style'],
  inlineNodes: readonly MarkdownInline[],
): PortableTextBlock {
  const markDefs: PortableTextMarkDef[] = [];
  const children = inlineNodes.map((node, index) =>
    convertInline(node, `${key}s${String(index + 1)}`, markDefs),
  );

  return { _type: 'block', _key: key, style, children, markDefs };
}

function convertInline(
  node: MarkdownInline,
  key: string,
  markDefs: PortableTextMarkDef[],
): PortableTextSpan {
  switch (node.type) {
    case 'text':
      return { _type: 'span', _key: key, text: node.value, marks: [] };
    case 'strong':
      return { _type: 'span', _key: key, text: node.value, marks: ['strong'] };
    case 'em':
      return { _type: 'span', _key: key, text: node.value, marks: ['em'] };
    case 'underline':
      return { _type: 'span', _key: key, text: node.value, marks: ['underline'] };
    case 'strike':
      return { _type: 'span', _key: key, text: node.value, marks: ['strike-through'] };
    case 'code':
      return { _type: 'span', _key: key, text: node.value, marks: ['code'] };
    case 'link': {
      if (!isAllowedHref(node.href)) {
        throw new ValidationError('portable-text', [
          `External link href is invalid: "${node.href}".`,
        ]);
      }
      const markKey = `link${String(markDefs.length + 1)}`;
      markDefs.push({
        _key: markKey,
        _type: 'link',
        href: node.href,
        blank: true,
        nofollow: false,
      });
      return { _type: 'span', _key: key, text: node.value, marks: [markKey] };
    }
    case 'internalLink': {
      if (node.targetId.trim().length === 0) {
        throw new ValidationError('portable-text', ['Internal link reference must be non-empty.']);
      }
      const markKey = `internal${String(markDefs.length + 1)}`;
      markDefs.push({
        _key: markKey,
        _type: 'internalLink',
        reference: { _type: 'reference', _ref: node.targetId },
      });
      return { _type: 'span', _key: key, text: node.value, marks: [markKey] };
    }
    case 'linkMarker':
      throw new ValidationError('portable-text', [
        `Unresolved internal-link marker: "${node.value}".`,
      ]);
    case 'imageMarker':
      throw new ValidationError('portable-text', [`Unresolved image marker: "${node.value}".`]);
  }
}

function extractSanityReference(source: string, kind: string): string {
  const prefix = 'sanity:';
  if (!source.startsWith(prefix) || source.slice(prefix.length).trim().length === 0) {
    throw new ValidationError('portable-text', [
      `${kind} source "${source}" must use the resolved "sanity:<assetId>" form.`,
    ]);
  }
  return source.slice(prefix.length);
}

function isAllowedHref(href: string): boolean {
  if (href.startsWith('/')) {
    return !href.startsWith('//');
  }

  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
