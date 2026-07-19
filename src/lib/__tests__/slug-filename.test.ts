import { describe, expect, it } from 'vitest';

import { createSafeFilename, normalizeExtension } from '@/lib/filename.js';
import { resolveSlugCollision, slugify } from '@/lib/slug.js';

describe('slugify', () => {
  it('uses the documented Blogspage seed-meta algorithm exactly', () => {
    expect(slugify('Why Direct Booking Beats OTAs for Independent Hotels')).toBe(
      'why-direct-booking-beats-otas-for-independent-hotels',
    );
    expect(slugify('R&D: 10% Growth!!!')).toBe('rd-10-growth');
  });

  it('normalizes Unicode by dropping non-ASCII characters per the canonical algorithm', () => {
    expect(slugify('Café 東京 & Hotels')).toBe('caf-hotels');
  });

  it('handles blanks and punctuation deterministically', () => {
    expect(slugify('')).toBe('');
    expect(slugify(' --- ')).toBe('');
    expect(slugify('a---b')).toBe('a-b');
  });
});

describe('resolveSlugCollision', () => {
  it('keeps a base slug when it is available', () => {
    expect(resolveSlugCollision('direct-booking', new Set())).toBe('direct-booking');
  });

  it('uses incrementing numeric suffixes for collisions', () => {
    expect(
      resolveSlugCollision('direct-booking', new Set(['direct-booking', 'direct-booking-2'])),
    ).toBe('direct-booking-3');
  });

  it('rejects invalid inputs and exhausted suffix space', () => {
    expect(() => resolveSlugCollision('', new Set())).toThrow(RangeError);
    expect(() => resolveSlugCollision('a', new Set(), 0)).toThrow(RangeError);
    expect(() => resolveSlugCollision('a', new Set(['a', 'a-2']), 1)).toThrow(RangeError);
  });
});

describe('createSafeFilename', () => {
  it('normalizes a label and adds a stable collision-resistant short hash', () => {
    expect(createSafeFilename('Hotel Room Matrix.jpg')).toMatch(
      /^hotel-room-matrix-[a-f0-9]{8}\.jpg$/,
    );
    expect(createSafeFilename('Hotel Room Matrix.jpg')).toBe(
      createSafeFilename('Hotel Room Matrix.jpg'),
    );
  });

  it('distinguishes labels that normalize to the same slug', () => {
    expect(createSafeFilename('R&D.jpg')).not.toBe(createSafeFilename('RD.jpg'));
  });

  it('normalizes extensions and rejects unsafe values', () => {
    expect(normalizeExtension('JPG')).toBe('.jpg');
    expect(normalizeExtension('.webp')).toBe('.webp');
    expect(normalizeExtension('')).toBe('');
    expect(() => normalizeExtension('../png')).toThrow(RangeError);
  });

  it('handles Unicode and accepts an explicit extension', () => {
    expect(createSafeFilename('東京 hotel', { extension: 'png', hashLength: 4 })).toMatch(
      /^hotel-[a-f0-9]{4}\.png$/,
    );
  });

  it('rejects blank labels and invalid hash lengths', () => {
    expect(() => createSafeFilename('   ')).toThrow(RangeError);
    expect(() => createSafeFilename('image', { hashLength: 0 })).toThrow(RangeError);
    expect(() => createSafeFilename('image', { hashLength: 65 })).toThrow(RangeError);
  });
});
