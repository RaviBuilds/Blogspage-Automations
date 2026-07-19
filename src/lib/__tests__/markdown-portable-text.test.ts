import { describe, expect, it } from 'vitest';

import {
  countMarkdownWords,
  extractHeadings,
  extractMarkers,
  parseMarkdown,
} from '@/lib/markdown.js';
import { fromMarkdownAst, type PortableTextNode } from '@/lib/portableText/fromMarkdownAst.js';
import { validatePortableText } from '@/lib/portableText/validatePortableText.js';
import { ValidationError } from '@/core/errors.js';

const FULL_MARKDOWN = `## The Commission Problem

**OTA commission** cuts directly into margin. Visit [Blogspage](https://blogspage.com) or [our guide](internal:post-123).

- Own the customer relationship
  - Keep availability current
1. Measure acquisition cost

> Performance is a feature.

![Hotel availability dashboard](sanity:image-asset-123 "Live room matrix")

\`\`\`typescript booking.ts
export const availability = 'live'
\`\`\`

:::cta
{"headline":"Own your booking channel","body":"Map a direct-booking launch plan.","primaryLabel":"Talk to our AI","secondaryLabel":"See how we work","secondaryHref":"/#process"}
:::`;

describe('Markdown inspection and parsing', () => {
  it('counts Unicode words, headings, and writer markers deterministically', () => {
    expect(countMarkdownWords("Café owners' rooms 東京")).toBe(4);
    expect(extractHeadings('## One\n### Two\n#### Three')).toEqual([
      { level: 2, text: 'One' },
      { level: 3, text: 'Two' },
      { level: 4, text: 'Three' },
    ]);
    expect(extractMarkers('[[link: guide]] then [[image: lobby]]')).toEqual([
      { type: 'link', value: 'guide' },
      { type: 'image', value: 'lobby' },
    ]);
  });

  it('parses every supported block type in the constrained pipeline subset', () => {
    const document = parseMarkdown(FULL_MARKDOWN);

    expect(document.children.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'listItem',
      'listItem',
      'listItem',
      'blockquote',
      'image',
      'codeBlock',
      'cta',
    ]);
  });

  it('rejects disallowed heading levels and malformed fences/CTA blocks', () => {
    expect(() => parseMarkdown('# Page title')).toThrow(ValidationError);
    expect(() => parseMarkdown('```typescript\nconst broken = true')).toThrow(ValidationError);
    expect(() => parseMarkdown(':::cta\n{}\n:::')).toThrow(ValidationError);
    expect(() => parseMarkdown('   - odd indentation')).toThrow(ValidationError);
  });
});

describe('fromMarkdownAst', () => {
  it('converts every supported markdown block to valid Blogspage Portable Text', () => {
    const nodes = fromMarkdownAst(parseMarkdown(FULL_MARKDOWN));

    expect(nodes.map((node) => node._type)).toEqual([
      'block',
      'block',
      'block',
      'block',
      'block',
      'block',
      'image',
      'codeBlock',
      'ctaBlock',
    ]);

    const paragraph = nodes[1];
    expect(paragraph?._type).toBe('block');
    if (paragraph?._type === 'block') {
      expect(paragraph.markDefs).toEqual([
        {
          _key: 'link1',
          _type: 'link',
          href: 'https://blogspage.com',
          blank: true,
          nofollow: false,
        },
        {
          _key: 'internal2',
          _type: 'internalLink',
          reference: { _type: 'reference', _ref: 'post-123' },
        },
      ]);
    }

    validatePortableText(nodes);
  });

  it('normalizes unsupported code languages to text', () => {
    const nodes = fromMarkdownAst(parseMarkdown('```rust\nfn main() {}\n```'));
    expect(nodes[0]).toMatchObject({ _type: 'codeBlock', language: 'text' });
  });

  it('fails closed on unresolved writer markers and unresolved image references', () => {
    expect(() => fromMarkdownAst(parseMarkdown('[[link: unresolved link]]'))).toThrow(
      ValidationError,
    );
    expect(() => fromMarkdownAst(parseMarkdown('![Alt](https://example.test/image.jpg)'))).toThrow(
      ValidationError,
    );
  });
});

describe('validatePortableText', () => {
  const validNode: PortableTextNode = {
    _type: 'block',
    _key: 'block-1',
    style: 'normal',
    markDefs: [],
    children: [{ _type: 'span', _key: 'span-1', text: 'Valid content', marks: [] }],
  };

  it('accepts a valid structural fixture', () => {
    expect(() => validatePortableText([validNode])).not.toThrow();
  });

  it('rejects all central structural invariants', () => {
    const invalidNodes = [
      { ...validNode, _key: '', children: [] },
      {
        ...validNode,
        _key: 'block-2',
        style: 'h1' as 'normal',
        children: [{ _type: 'span' as const, _key: 'span-2', text: 'X', marks: ['orphan'] }],
      },
      {
        ...validNode,
        _key: 'block-3',
        markDefs: [
          {
            _key: 'link-1',
            _type: 'link' as const,
            href: 'javascript:alert(1)',
            blank: true,
            nofollow: false,
          },
        ],
      },
      { ...validNode, _key: 'block-1' },
    ] as const;

    expect(() => validatePortableText(invalidNodes)).toThrow(ValidationError);
  });

  it('rejects empty content', () => {
    expect(() => validatePortableText([])).toThrow(ValidationError);
  });
});
