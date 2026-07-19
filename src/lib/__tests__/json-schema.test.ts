import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ValidationError } from '@/core/errors.js';
import { extractJsonValue, parseJsonWithSchema } from '@/lib/json.js';
import { assertValid, formatSchemaIssues } from '@/lib/schemaValidator.js';

const ARTICLE_SCHEMA = z.object({ title: z.string().min(1), tags: z.array(z.string()) });

describe('extractJsonValue', () => {
  it('extracts JSON from surrounding prose and preserves braces inside strings', () => {
    expect(extractJsonValue('Here:\n```json\n{"text":"{safe}"}\n```', 'writer')).toBe(
      '{"text":"{safe}"}',
    );
    expect(extractJsonValue('Before ["a", {"b": 2}] after', 'writer')).toBe('["a", {"b": 2}]');
  });

  it('fails with typed validation errors for absent or incomplete JSON', () => {
    expect(() => extractJsonValue('No structured response', 'writer')).toThrow(ValidationError);
    expect(() => extractJsonValue('{"incomplete": true', 'writer')).toThrow(ValidationError);
  });
});

describe('parseJsonWithSchema', () => {
  it('parses valid JSON and validates it with Zod', () => {
    expect(
      parseJsonWithSchema(
        '```json\n{"title":"Direct booking","tags":["hotel"]}\n```',
        ARTICLE_SCHEMA,
        'writer',
      ),
    ).toEqual({
      title: 'Direct booking',
      tags: ['hotel'],
    });
  });

  it('converts malformed JSON and schema failures into typed ValidationError', () => {
    expect(() => parseJsonWithSchema('{not json}', ARTICLE_SCHEMA, 'writer')).toThrow(
      ValidationError,
    );
    expect(() =>
      parseJsonWithSchema('{"title":"","tags":"hotel"}', ARTICLE_SCHEMA, 'writer'),
    ).toThrow(ValidationError);
  });
});

describe('schemaValidator', () => {
  it('returns parsed typed data on success', () => {
    expect(assertValid(ARTICLE_SCHEMA, { title: 'A', tags: [] }, 'writer')).toEqual({
      title: 'A',
      tags: [],
    });
  });

  it('formats nested field paths consistently', () => {
    expect(formatSchemaIssues([{ path: ['article', 'title'], message: 'Required' }])).toEqual([
      'article.title: Required',
    ]);
    expect(() => assertValid(ARTICLE_SCHEMA, { title: '', tags: 'bad' }, 'writer')).toThrow(
      ValidationError,
    );
  });
});
