import { ValidationError } from '@/core/errors.js';

/** A lightweight, deterministic AST for the constrained Markdown this pipeline emits. */
export interface MarkdownDocument {
  readonly type: 'document';
  readonly children: readonly MarkdownBlock[];
}

/** Supported block nodes in the pipeline's constrained Markdown subset. */
export type MarkdownBlock =
  | MarkdownHeading
  | MarkdownParagraph
  | MarkdownListItem
  | MarkdownBlockquote
  | MarkdownCodeBlock
  | MarkdownImage
  | MarkdownCta;

export interface MarkdownHeading {
  readonly type: 'heading';
  readonly level: 2 | 3 | 4;
  readonly children: readonly MarkdownInline[];
}
export interface MarkdownParagraph {
  readonly type: 'paragraph';
  readonly children: readonly MarkdownInline[];
}
export interface MarkdownListItem {
  readonly type: 'listItem';
  readonly ordered: boolean;
  readonly level: number;
  readonly children: readonly MarkdownInline[];
}
export interface MarkdownBlockquote {
  readonly type: 'blockquote';
  readonly children: readonly MarkdownInline[];
}
export interface MarkdownCodeBlock {
  readonly type: 'codeBlock';
  readonly language: string;
  readonly filename?: string;
  readonly code: string;
}
export interface MarkdownImage {
  readonly type: 'image';
  readonly alt: string;
  readonly source: string;
  readonly caption?: string;
}
export interface MarkdownCta {
  readonly type: 'cta';
  readonly headline: string;
  readonly body: string;
  readonly primaryLabel: string;
  readonly secondaryLabel: string;
  readonly secondaryHref: string;
}

/** Supported inline nodes. Inline nesting is intentionally not part of this subset. */
export type MarkdownInline =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'strong'; readonly value: string }
  | { readonly type: 'em'; readonly value: string }
  | { readonly type: 'underline'; readonly value: string }
  | { readonly type: 'strike'; readonly value: string }
  | { readonly type: 'code'; readonly value: string }
  | { readonly type: 'link'; readonly value: string; readonly href: string }
  | { readonly type: 'internalLink'; readonly value: string; readonly targetId: string }
  | { readonly type: 'linkMarker'; readonly value: string }
  | { readonly type: 'imageMarker'; readonly value: string };

const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
const BULLET_PATTERN = /^(\s*)[-*+]\s+(.+)$/;
const ORDERED_PATTERN = /^(\s*)\d+\.\s+(.+)$/;
const BLOCKQUOTE_PATTERN = /^>\s?(.*)$/;
const IMAGE_PATTERN = /^!\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)$/;
const INLINE_PATTERN =
  /(\[\[link:\s*([^\]]+?)\s*\]\]|\[\[image:\s*([^\]]+?)\s*\]\]|!?(?:\[([^\]]+)\]\(([^)]+)\))|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|`([^`]+)`|\*([^*]+)\*)/g;

/** Counts words using Unicode letter/number runs, not ASCII whitespace splitting. */
export function countMarkdownWords(markdown: string): number {
  return Array.from(markdown.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)).length;
}

/** Extracts every H2/H3/H4 heading in source order. */
export function extractHeadings(
  markdown: string,
): readonly { readonly level: 2 | 3 | 4; readonly text: string }[] {
  return parseMarkdown(markdown)
    .children.filter((block): block is MarkdownHeading => block.type === 'heading')
    .map((heading) => ({ level: heading.level, text: inlineText(heading.children) }));
}

/** Extracts all internal link and image markers in source order. */
export function extractMarkers(
  markdown: string,
): readonly { readonly type: 'link' | 'image'; readonly value: string }[] {
  const markers: { type: 'link' | 'image'; value: string }[] = [];
  const pattern = /\[\[(link|image):\s*([^\]]+?)\s*\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(markdown)) !== null) {
    markers.push({ type: match[1] === 'link' ? 'link' : 'image', value: match[2] ?? '' });
  }

  return markers;
}

/** Parses the constrained, documented Markdown subset into a deterministic AST. */
export function parseMarkdown(markdown: string): MarkdownDocument {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const children: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const header = line.slice(3).trim().split(/\s+/, 2);
      const language = header[0] || 'text';
      const filename = header[1];
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index >= lines.length) {
        throw new ValidationError('markdown', ['Unclosed fenced code block.']);
      }
      children.push({
        type: 'codeBlock',
        language,
        ...(filename === undefined ? {} : { filename }),
        code: codeLines.join('\n'),
      });
      index += 1;
      continue;
    }

    if (line === ':::cta') {
      const ctaLines: string[] = [];
      index += 1;
      while (index < lines.length && (lines[index] ?? '') !== ':::') {
        ctaLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index >= lines.length) {
        throw new ValidationError('markdown', ['Unclosed :::cta block.']);
      }
      children.push(parseCta(ctaLines.join('\n')));
      index += 1;
      continue;
    }

    const imageMatch = line.match(IMAGE_PATTERN);
    if (imageMatch !== null) {
      children.push({
        type: 'image',
        alt: imageMatch[1] ?? '',
        source: imageMatch[2] ?? '',
        ...(imageMatch[3] === undefined ? {} : { caption: imageMatch[3] }),
      });
      index += 1;
      continue;
    }

    const headingMatch = line.match(HEADING_PATTERN);
    if (headingMatch !== null) {
      const level = headingMatch[1]?.length ?? 0;
      if (level < 2 || level > 4) {
        throw new ValidationError('markdown', [
          `Heading level ${String(level)} is not supported; use H2, H3, or H4.`,
        ]);
      }
      children.push({
        type: 'heading',
        level: level as 2 | 3 | 4,
        children: parseInline(headingMatch[2] ?? ''),
      });
      index += 1;
      continue;
    }

    const quoteMatch = line.match(BLOCKQUOTE_PATTERN);
    if (quoteMatch !== null) {
      children.push({ type: 'blockquote', children: parseInline(quoteMatch[1] ?? '') });
      index += 1;
      continue;
    }

    const listMatch = line.match(BULLET_PATTERN) ?? line.match(ORDERED_PATTERN);
    if (listMatch !== null) {
      const ordered = line.match(ORDERED_PATTERN) !== null;
      const indentation = listMatch[1]?.length ?? 0;
      if (indentation % 2 !== 0) {
        throw new ValidationError('markdown', ['List indentation must use two spaces per level.']);
      }
      children.push({
        type: 'listItem',
        ordered,
        level: indentation / 2 + 1,
        children: parseInline(listMatch[2] ?? ''),
      });
      index += 1;
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (index < lines.length && isParagraphContinuation(lines[index] ?? '')) {
      paragraphLines.push((lines[index] ?? '').trim());
      index += 1;
    }
    children.push({ type: 'paragraph', children: parseInline(paragraphLines.join(' ')) });
  }

  return { type: 'document', children };
}

/** Returns plain display text from a constrained inline-node list. */
export function inlineText(nodes: readonly MarkdownInline[]): string {
  return nodes.map((node) => node.value).join('');
}

function isParagraphContinuation(line: string): boolean {
  return (
    line.trim().length > 0 &&
    !line.startsWith('```') &&
    line !== ':::cta' &&
    !IMAGE_PATTERN.test(line) &&
    HEADING_PATTERN.test(line) === false &&
    BLOCKQUOTE_PATTERN.test(line) === false &&
    BULLET_PATTERN.test(line) === false &&
    ORDERED_PATTERN.test(line) === false
  );
}

function parseInline(value: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const pattern = new RegExp(INLINE_PATTERN);

  while ((match = pattern.exec(value)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', value: value.slice(lastIndex, match.index) });
    }

    const token = match[0] ?? '';
    if (match[2] !== undefined) nodes.push({ type: 'linkMarker', value: match[2] });
    else if (match[3] !== undefined) nodes.push({ type: 'imageMarker', value: match[3] });
    else if (match[4] !== undefined && match[5] !== undefined) {
      const href = match[5].trim();
      nodes.push(
        href.startsWith('internal:')
          ? { type: 'internalLink', value: match[4], targetId: href.slice('internal:'.length) }
          : { type: 'link', value: match[4], href },
      );
    } else if (match[6] !== undefined) nodes.push({ type: 'strong', value: match[6] });
    else if (match[7] !== undefined) nodes.push({ type: 'underline', value: match[7] });
    else if (match[8] !== undefined) nodes.push({ type: 'strike', value: match[8] });
    else if (match[9] !== undefined) nodes.push({ type: 'code', value: match[9] });
    else if (match[10] !== undefined) nodes.push({ type: 'em', value: match[10] });
    else nodes.push({ type: 'text', value: token });
    lastIndex = match.index + token.length;
  }

  if (lastIndex < value.length) {
    nodes.push({ type: 'text', value: value.slice(lastIndex) });
  }

  return nodes.length === 0 ? [{ type: 'text', value }] : nodes;
}

function parseCta(source: string): MarkdownCta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new ValidationError('markdown', [':::cta blocks must contain one valid JSON object.']);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('markdown', [':::cta content must be a JSON object.']);
  }
  const value = parsed as Record<string, unknown>;
  const fields = ['headline', 'body', 'primaryLabel', 'secondaryLabel', 'secondaryHref'] as const;
  const missing = fields.filter(
    (field) => typeof value[field] !== 'string' || value[field].trim().length === 0,
  );
  if (missing.length > 0) {
    throw new ValidationError('markdown', [
      `:::cta requires non-empty string field(s): ${missing.join(', ')}.`,
    ]);
  }
  return {
    type: 'cta',
    headline: value.headline as string,
    body: value.body as string,
    primaryLabel: value.primaryLabel as string,
    secondaryLabel: value.secondaryLabel as string,
    secondaryHref: value.secondaryHref as string,
  };
}
