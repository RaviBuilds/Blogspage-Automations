import { ValidationError } from '@/core/errors.js';
import type {
  PortableTextBlock,
  PortableTextMarkDef,
  PortableTextNode,
} from '@/lib/portableText/fromMarkdownAst.js';

const DECORATOR_MARKS = new Set(['strong', 'em', 'underline', 'strike-through', 'code']);
const BLOCK_STYLES = new Set(['normal', 'h2', 'h3', 'h4', 'blockquote']);
const CODE_LANGUAGES = new Set([
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
 * Validates every Blogspage Portable Text invariant documented in
 * `knowledge/automation-integration.md` before a future integration writes it.
 *
 * @throws {ValidationError} When any structural invariant is violated.
 */
export function validatePortableText(value: readonly PortableTextNode[]): void {
  const issues: string[] = [];
  const allKeys = new Set<string>();

  if (value.length === 0) {
    issues.push('Portable Text content must contain at least one node.');
  }

  for (const [index, node] of value.entries()) {
    validateKey(node._key, `content[${String(index)}]._key`, allKeys, issues);

    switch (node._type) {
      case 'block':
        validateBlock(node, index, allKeys, issues);
        break;
      case 'image':
        if (node.alt.trim().length === 0)
          issues.push(`content[${String(index)}].alt must be non-empty.`);
        if (!isNonEmptyReference(node.asset))
          issues.push(`content[${String(index)}].asset must be a non-empty reference.`);
        break;
      case 'codeBlock':
        if (!CODE_LANGUAGES.has(node.language))
          issues.push(`content[${String(index)}].language is not allowed.`);
        if (node.code.length === 0)
          issues.push(`content[${String(index)}].code must be non-empty.`);
        break;
      case 'ctaBlock':
        for (const field of [
          'headline',
          'body',
          'primaryLabel',
          'secondaryLabel',
          'secondaryHref',
        ] as const) {
          if (node[field].trim().length === 0)
            issues.push(`content[${String(index)}].${field} must be non-empty.`);
        }
        break;
      default:
        issues.push(`content[${String(index)}] has an unsupported _type.`);
    }
  }

  if (issues.length > 0) {
    throw new ValidationError('portable-text', issues);
  }
}

function validateBlock(
  block: PortableTextBlock,
  index: number,
  allKeys: Set<string>,
  issues: string[],
): void {
  if (!BLOCK_STYLES.has(block.style))
    issues.push(`content[${String(index)}].style is not allowed.`);
  if (block.listItem !== undefined && block.listItem !== 'bullet' && block.listItem !== 'number') {
    issues.push(`content[${String(index)}].listItem is not allowed.`);
  }
  if (block.level !== undefined && (!Number.isSafeInteger(block.level) || block.level < 1)) {
    issues.push(`content[${String(index)}].level must be a positive safe integer.`);
  }
  if (block.children.length === 0)
    issues.push(`content[${String(index)}].children must be non-empty.`);

  const markDefKeys = new Set<string>();
  for (const markDef of block.markDefs) {
    validateKey(markDef._key, `content[${String(index)}].markDefs`, allKeys, issues);
    if (markDefKeys.has(markDef._key))
      issues.push(`content[${String(index)}].markDefs contains a duplicate _key.`);
    markDefKeys.add(markDef._key);
    validateMarkDef(markDef, index, issues);
  }

  for (const [childIndex, child] of block.children.entries()) {
    validateKey(
      child._key,
      `content[${String(index)}].children[${String(childIndex)}]`,
      allKeys,
      issues,
    );
    if (child._type !== 'span')
      issues.push(`content[${String(index)}].children[${String(childIndex)}] must be a span.`);
    for (const mark of child.marks) {
      if (!DECORATOR_MARKS.has(mark) && !markDefKeys.has(mark)) {
        issues.push(
          `content[${String(index)}].children[${String(childIndex)}] has orphan mark "${mark}".`,
        );
      }
    }
  }
}

function validateMarkDef(markDef: PortableTextMarkDef, index: number, issues: string[]): void {
  if (markDef._type === 'link') {
    if (!isAllowedHref(markDef.href))
      issues.push(`content[${String(index)}] has an invalid external link href.`);
  } else if (markDef._type === 'internalLink') {
    if (!isNonEmptyReference(markDef.reference))
      issues.push(`content[${String(index)}] has an invalid internal link reference.`);
  } else {
    issues.push(`content[${String(index)}] has an unsupported markDef.`);
  }
}

function validateKey(key: string, path: string, allKeys: Set<string>, issues: string[]): void {
  if (key.trim().length === 0) {
    issues.push(`${path}._key must be non-empty.`);
    return;
  }
  if (allKeys.has(key)) issues.push(`Duplicate _key "${key}" found at ${path}.`);
  allKeys.add(key);
}

function isNonEmptyReference(value: { readonly _type: string; readonly _ref: string }): boolean {
  return value._type === 'reference' && value._ref.trim().length > 0;
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
