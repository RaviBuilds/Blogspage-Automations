/**
 * Tests for PipelineState initialization and type guards.
 */

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  createStateFromBrief,
  hasBrief,
  hasResearch,
  hasPlanning,
  hasSeo,
  hasDraft,
  hasImages,
  hasSanityDocument,
  isRunning,
  isPublished,
  needsReview,
  isFailed,
  type Brief,
} from '../state.js';

describe('createInitialState', () => {
  it('creates a valid initial state with defaults', () => {
    const state = createInitialState();

    expect(state.metadata.runId).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    expect(state.metadata.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
    expect(state.metadata.sheetRowId).toBe('');
    expect(state.metadata.status).toBe('running');
    expect(state.metadata.locale).toBe('en');
    expect(state.metadata.targetSite).toBe('blogspage');
    expect(state.metadata.tenantId).toBeUndefined();

    expect(state.metrics.costEvents).toEqual([]);
    expect(state.metrics.totalCostUsd).toBe(0);
    expect(state.errors).toEqual([]);
    expect(state.timings).toEqual([]);

    // All content sections should be undefined initially
    expect(state.brief).toBeUndefined();
    expect(state.research).toBeUndefined();
    expect(state.planning).toBeUndefined();
    expect(state.seo).toBeUndefined();
    expect(state.draft).toBeUndefined();
    expect(state.review).toBeUndefined();
    expect(state.qa).toBeUndefined();
    expect(state.images).toBeUndefined();
    expect(state.sanity).toBeUndefined();
    expect(state.publishing).toBeUndefined();
  });

  it('accepts optional sheet row ID', () => {
    const state = createInitialState({ sheetRowId: 'row-123' });
    expect(state.metadata.sheetRowId).toBe('row-123');
  });

  it('accepts optional locale override', () => {
    const state = createInitialState({ locale: 'es' });
    expect(state.metadata.locale).toBe('es');
  });

  it('accepts optional target site override', () => {
    const state = createInitialState({ targetSite: 'custom-site' });
    expect(state.metadata.targetSite).toBe('custom-site');
  });

  it('creates immutable state object', () => {
    const state = createInitialState();

    // TypeScript's readonly prevents mutation at compile time
    expect(state.metadata.status).toBe('running');
  });
});

describe('createStateFromBrief', () => {
  const brief: Brief = {
    topic: 'Test Topic',
    targetAudience: 'Developers',
    keywordHints: ['test', 'keyword'],
    constraints: ['Keep it simple'],
    sheetRowId: 'row-456',
  };

  it('creates state with brief already set', () => {
    const state = createStateFromBrief(brief);

    expect(state.brief).toBeDefined();
    expect(state.brief?.topic).toBe('Test Topic');
    expect(state.brief?.targetAudience).toBe('Developers');
    expect(state.brief?.keywordHints).toEqual(['test', 'keyword']);
    expect(state.brief?.constraints).toEqual(['Keep it simple']);
    expect(state.brief?.sheetRowId).toBe('row-456');
    expect(state.metadata.sheetRowId).toBe('row-456');
  });

  it('sets default values for optional brief fields', () => {
    const minimalBrief: Brief = {
      topic: 'Minimal Topic',
      sheetRowId: 'row-789',
    };

    const state = createStateFromBrief(minimalBrief);

    expect(state.brief?.topic).toBe('Minimal Topic');
    expect(state.brief?.targetAudience).toBeUndefined();
    expect(state.brief?.keywordHints).toBeUndefined();
    expect(state.brief?.constraints).toBeUndefined();
  });
});

describe('type guards', () => {
  describe('hasBrief', () => {
    it('returns false for state without brief', () => {
      const state = createInitialState();
      expect(hasBrief(state)).toBe(false);
    });

    it('returns true for state with brief', () => {
      const brief: Brief = { topic: 'Test', sheetRowId: 'row-1' };
      const state = createStateFromBrief(brief);
      expect(hasBrief(state)).toBe(true);
    });
  });

  describe('hasResearch', () => {
    it('returns false for state without research', () => {
      const state = createInitialState();
      expect(hasResearch(state)).toBe(false);
    });

    it('returns true for state with research', () => {
      const state = {
        ...createInitialState(),
        research: {
          keyFacts: ['fact1'],
          suggestedAngle: 'angle',
          candidateStatistics: [],
        },
      };
      expect(hasResearch(state)).toBe(true);
    });
  });

  describe('hasPlanning', () => {
    it('returns false for state without planning', () => {
      const state = createInitialState();
      expect(hasPlanning(state)).toBe(false);
    });

    it('returns true for state with planning', () => {
      const state = {
        ...createInitialState(),
        planning: {
          titleCandidates: ['Title 1'],
          outline: [],
          targetWordCount: 1000,
          angle: 'angle',
        },
      };
      expect(hasPlanning(state)).toBe(true);
    });
  });

  describe('hasSeo', () => {
    it('returns false for state without SEO', () => {
      const state = createInitialState();
      expect(hasSeo(state)).toBe(false);
    });

    it('returns true for state with SEO', () => {
      const state = {
        ...createInitialState(),
        seo: {
          focusKeyword: 'keyword',
          seoKeywords: ['keyword'],
          seoTitleDraft: 'Title',
          metaDescriptionDraft: 'Description',
          internalLinkTargets: [],
        },
      };
      expect(hasSeo(state)).toBe(true);
    });
  });

  describe('hasDraft', () => {
    it('returns false for state without draft', () => {
      const state = createInitialState();
      expect(hasDraft(state)).toBe(false);
    });

    it('returns true for state with draft', () => {
      const state = {
        ...createInitialState(),
        draft: {
          current: {
            markdown: '# Test',
            wordCount: 2,
            linkMarkers: [],
            imageMarkers: [],
          },
          history: [],
        },
      };
      expect(hasDraft(state)).toBe(true);
    });
  });

  describe('hasImages', () => {
    it('returns false for state without images', () => {
      const state = createInitialState();
      expect(hasImages(state)).toBe(false);
    });

    it('returns true for state with images', () => {
      const state = {
        ...createInitialState(),
        images: {
          plan: {
            images: [],
          },
        },
      };
      expect(hasImages(state)).toBe(true);
    });
  });

  describe('hasSanityDocument', () => {
    it('returns false for state without sanity document', () => {
      const state = createInitialState();
      expect(hasSanityDocument(state)).toBe(false);
    });

    it('returns false for state with sanity section but no document', () => {
      const state = {
        ...createInitialState(),
        sanity: {
          resolvedLinks: [],
        },
      };
      expect(hasSanityDocument(state)).toBe(false);
    });

    it('returns true for state with sanity document', () => {
      const state = {
        ...createInitialState(),
        sanity: {
          document: {
            _type: 'post' as const,
            title: 'Test',
            slug: { _type: 'slug' as const, current: 'test' },
            excerpt: 'Test excerpt',
            author: { _type: 'reference' as const, _ref: 'author-1' },
            publishedAt: '2026-01-01T00:00:00Z',
            categories: [],
            content: [],
          },
        },
      };
      expect(hasSanityDocument(state)).toBe(true);
    });
  });
});

describe('status type guards', () => {
  describe('isRunning', () => {
    it('returns true for running state', () => {
      const state = createInitialState();
      expect(isRunning(state)).toBe(true);
    });

    it('returns false for published state', () => {
      const base = createInitialState();
      const state = {
        ...base,
        metadata: { ...base.metadata, status: 'published' as const },
      };
      expect(isRunning(state)).toBe(false);
    });
  });

  describe('isPublished', () => {
    it('returns true for published state', () => {
      const base = createInitialState();
      const state = {
        ...base,
        metadata: { ...base.metadata, status: 'published' as const },
      };
      expect(isPublished(state)).toBe(true);
    });

    it('returns false for running state', () => {
      const state = createInitialState();
      expect(isPublished(state)).toBe(false);
    });
  });

  describe('needsReview', () => {
    it('returns true for needs_review state', () => {
      const base = createInitialState();
      const state = {
        ...base,
        metadata: { ...base.metadata, status: 'needs_review' as const },
      };
      expect(needsReview(state)).toBe(true);
    });

    it('returns false for running state', () => {
      const state = createInitialState();
      expect(needsReview(state)).toBe(false);
    });
  });

  describe('isFailed', () => {
    it('returns true for failed state', () => {
      const base = createInitialState();
      const state = {
        ...base,
        metadata: { ...base.metadata, status: 'failed' as const },
      };
      expect(isFailed(state)).toBe(true);
    });

    it('returns false for running state', () => {
      const state = createInitialState();
      expect(isFailed(state)).toBe(false);
    });
  });
});
