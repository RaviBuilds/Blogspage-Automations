/**
 * Tests for PipelineState initialization, validation, ownership, and immutable updates.
 */

import { describe, expect, it } from 'vitest';
import {
  appendCostEvent,
  appendErrorRecord,
  appendTimingRecord,
  BriefSchema,
  createInitialState,
  createStateFromBrief,
  DraftSchema,
  hasBrief,
  hasDraft,
  hasImages,
  hasPlanning,
  hasResearch,
  hasSanityDocument,
  hasSeo,
  isFailed,
  isPublished,
  isRunning,
  migrateLegacyPipelineState,
  needsReview,
  PipelineStateSchema,
  replaceDraft,
  setPipelineStatus,
  setReviewLoopIteration,
  setSheetRowId,
  STATE_FIELD_OWNERS,
  type Brief,
  type CostEvent,
  type Draft,
  type ErrorRecord,
  type PipelineState,
  type TimingRecord,
} from '../state.js';

const FIRST_TIMESTAMP = '2026-07-22T12:00:00.000Z';
const SECOND_TIMESTAMP = '2026-07-22T12:01:00.000Z';

const initialDraft: Draft = {
  markdown: '# First draft',
  wordCount: 2,
  linkMarkers: [],
  imageMarkers: [],
};

const humanizedDraft: Draft = {
  markdown: '# Humanized draft',
  wordCount: 2,
  linkMarkers: [],
  imageMarkers: [],
};

const improvedDraft: Draft = {
  markdown: '# Improved draft',
  wordCount: 2,
  linkMarkers: [],
  imageMarkers: [],
};

function createCostEvent(runId: string, estimatedCostUsd = 0.01): CostEvent {
  return {
    runId,
    moduleKey: 'research',
    attemptNumber: 1,
    timestamp: FIRST_TIMESTAMP,
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5',
    promptVersion: 'abc1234',
    inputTokens: 100,
    outputTokens: 200,
    cachedInputTokens: 10,
    reasoningTokens: 0,
    estimatedCostUsd,
    pricingVerifiedAt: '2026-07-01',
    latencyMs: 250,
    outcome: 'success',
    isImageGeneration: false,
  };
}

function createCompleteState(): PipelineState {
  const initial = createInitialState({ sheetRowId: 'row-123' });
  const costEvent = createCostEvent(initial.metadata.runId);

  return {
    ...initial,
    metadata: {
      ...initial.metadata,
      tenantId: 'tenant-1',
    },
    brief: {
      topic: 'Pipeline state design',
      targetAudience: 'Engineering teams',
      keywordHints: ['pipeline', 'state'],
      constraints: ['Use TypeScript'],
      sheetRowId: 'row-123',
    },
    research: {
      keyFacts: ['Immutable state simplifies snapshots'],
      suggestedAngle: 'Explain the operational benefit',
      competitorGapNotes: ['Competitors omit migration'],
      candidateStatistics: [{ claim: 'A useful fact', informalSource: 'Research note' }],
    },
    planning: {
      titleCandidates: ['Pipeline State Done Right'],
      outline: [{ heading: 'Introduction', level: 2, talkingPoints: ['Explain the contract'] }],
      targetWordCount: 1200,
      angle: 'Reliable pipeline contracts',
    },
    seo: {
      focusKeyword: 'pipeline state',
      seoKeywords: ['pipeline', 'state'],
      seoTitleDraft: 'Pipeline State Guide',
      metaDescriptionDraft: 'A guide to pipeline state.',
      internalLinkTargets: [
        {
          candidateSlug: 'state-guide',
          candidateTitle: 'State Guide',
          relevance: 'high',
        },
      ],
    },
    draft: {
      current: initialDraft,
      history: [],
    },
    review: {
      technical: {
        passed: true,
        issues: [],
      },
      seo: {
        passed: false,
        issues: [
          {
            id: 'seo-1',
            severity: 'medium',
            location: 'title',
            description: 'Use the focus keyword.',
            suggestedFix: 'Add it to the title.',
          },
        ],
        revisedSeoTitle: 'Pipeline State Guide',
        revisedMetaDescription: 'A better pipeline-state guide.',
      },
      loop: { iteration: 1 },
    },
    qa: {
      decision: 'needsRevision',
      remainingIssues: [],
    },
    images: {
      plan: {
        images: [
          {
            id: 'hero-1',
            role: 'hero',
            prompt: 'A clear state diagram',
            altTextDraft: 'Pipeline state diagram',
            aspectRatio: '16:9',
            placementMarkerId: 'image-hero',
          },
        ],
      },
      generated: [
        {
          imageId: 'hero-1',
          role: 'hero',
          data: { type: 'url', value: 'https://example.test/image.png' },
          contentType: 'image/png',
          generationMeta: {
            provider: 'openai',
            model: 'gpt-image-1',
            costUsd: 0.04,
          },
        },
      ],
      validation: [{ imageId: 'hero-1', passed: true, retriesUsed: 0 }],
      uploaded: [
        {
          imageId: 'hero-1',
          role: 'hero',
          assetId: 'image-asset-1',
          altText: 'Pipeline state diagram',
          placementMarkerId: 'image-hero',
        },
      ],
    },
    sanity: {
      resolvedLinks: [
        {
          markerId: 'link-1',
          targetPostId: 'post-1',
          targetSlug: 'state-guide',
          anchorText: 'state guide',
        },
      ],
      portableText: [
        {
          _type: 'block',
          _key: 'block-1',
          children: [],
          markDefs: [],
          style: 'normal',
        },
      ],
      faq: [
        {
          _type: 'faqItem',
          _key: 'faq-1',
          question: 'What is PipelineState?',
          answer: 'The pipeline data contract.',
        },
      ],
      structuredDataCheck: {
        ready: true,
        missing: [],
        autoFilled: ['excerpt'],
      },
      document: {
        _type: 'post',
        title: 'Pipeline State Guide',
        slug: { _type: 'slug', current: 'pipeline-state-guide' },
        excerpt: 'A guide to pipeline state.',
        author: { _type: 'reference', _ref: 'author-1' },
        publishedAt: FIRST_TIMESTAMP,
        categories: [{ _type: 'reference', _ref: 'category-1', _key: 'category-key-1' }],
        mainImage: {
          _type: 'image',
          alt: 'Pipeline state diagram',
          asset: { _type: 'reference', _ref: 'image-asset-1' },
        },
        content: [
          {
            _type: 'block',
            _key: 'block-1',
            children: [],
            markDefs: [],
            style: 'normal',
          },
        ],
        faq: [
          {
            _type: 'faqItem',
            _key: 'faq-1',
            question: 'What is PipelineState?',
            answer: 'The pipeline data contract.',
          },
        ],
        focusKeyword: 'pipeline state',
        seoKeywords: ['pipeline', 'state'],
        seoTitle: 'Pipeline State Guide',
        metaDescription: 'A guide to pipeline state.',
        featured: true,
        evergreen: true,
        customSanityField: 'permitted extension',
      },
    },
    publishing: {
      documentId: 'post-1',
      publishedAt: SECOND_TIMESTAMP,
      sheetRowUpdated: true,
      liveUrlEstimate: 'https://example.test/pipeline-state-guide',
    },
    metrics: {
      costEvents: [costEvent],
      totalCostUsd: costEvent.estimatedCostUsd,
    },
    errors: [
      {
        runId: initial.metadata.runId,
        module: 'research',
        errorClass: 'RetryableError',
        attemptNumber: 1,
        message: 'Transient failure',
        timestamp: FIRST_TIMESTAMP,
        resolved: true,
      },
    ],
    timings: [
      {
        runId: initial.metadata.runId,
        module: 'research',
        attemptNumber: 1,
        startedAt: FIRST_TIMESTAMP,
        durationMs: 250,
      },
    ],
  };
}

describe('builders and type guards', () => {
  it('creates initial state with the frozen defaults', () => {
    const state = createInitialState();

    expect(state.metadata.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.metadata.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state.metadata).toMatchObject({
      sheetRowId: '',
      status: 'running',
      locale: 'en',
      targetSite: 'blogspage',
    });
    expect(state.metrics).toEqual({ costEvents: [], totalCostUsd: 0 });
    expect(state.errors).toEqual([]);
    expect(state.timings).toEqual([]);
    expect(PipelineStateSchema.safeParse(state).success).toBe(true);
  });

  it('creates a state from a Brief and preserves its row ID', () => {
    const brief: Brief = {
      topic: 'Test Topic',
      targetAudience: 'Developers',
      keywordHints: ['test'],
      constraints: ['Keep it simple'],
      sheetRowId: 'row-456',
    };

    const state = createStateFromBrief(brief);

    expect(state.brief).toEqual(brief);
    expect(state.metadata.sheetRowId).toBe('row-456');
    expect(hasBrief(state)).toBe(true);
  });

  it('seeds an optional client profile id into metadata', () => {
    const state = createInitialState({ clientProfileId: 'blogspage' });

    expect(state.metadata.clientProfileId).toBe('blogspage');
    expect(PipelineStateSchema.safeParse(state).success).toBe(true);
  });

  it('narrows content and status guards from populated state', () => {
    const state = createCompleteState();

    expect(hasResearch(state)).toBe(true);
    expect(hasPlanning(state)).toBe(true);
    expect(hasSeo(state)).toBe(true);
    expect(hasDraft(state)).toBe(true);
    expect(hasImages(state)).toBe(true);
    expect(hasSanityDocument(state)).toBe(true);
    expect(isRunning(state)).toBe(true);
    expect(isPublished(setPipelineStatus(state, 'published'))).toBe(true);
    expect(needsReview(setPipelineStatus(state, 'needs_review'))).toBe(true);
    expect(isFailed(setPipelineStatus(state, 'failed'))).toBe(true);
  });
});

describe('runtime validation', () => {
  it('validates every documented nested section in a complete hand-written fixture', () => {
    const state = createCompleteState();

    expect(PipelineStateSchema.parse(state)).toEqual(state);
    expect(DraftSchema.parse(initialDraft)).toEqual(initialDraft);
    expect(BriefSchema.parse(state.brief)).toEqual(state.brief);
  });

  it('rejects malformed timestamps, invalid pricing dates, and invalid enum values', () => {
    const timestampState = createCompleteState();
    const malformedTimestamp = {
      ...timestampState,
      metadata: {
        ...timestampState.metadata,
        startedAt: '2026-07-22T12:00:00Z',
      },
    };

    const pricingState = createCompleteState();
    const [costEvent] = pricingState.metrics.costEvents;
    if (costEvent === undefined) {
      throw new Error('Expected cost event fixture.');
    }
    const invalidPricingDate = {
      ...pricingState,
      metrics: {
        ...pricingState.metrics,
        costEvents: [{ ...costEvent, pricingVerifiedAt: '2026-02-30' }],
      },
    };

    const statusState = createCompleteState();
    const invalidStatus = {
      ...statusState,
      metadata: {
        ...statusState.metadata,
        status: 'invalid',
      },
    };

    expect(PipelineStateSchema.safeParse(malformedTimestamp).success).toBe(false);
    expect(PipelineStateSchema.safeParse(invalidPricingDate).success).toBe(false);
    expect(PipelineStateSchema.safeParse(invalidStatus).success).toBe(false);

    const awaitingState = createCompleteState();
    const awaitingAssets = {
      ...awaitingState,
      metadata: {
        ...awaitingState.metadata,
        status: 'awaiting_assets',
      },
    };
    expect(PipelineStateSchema.safeParse(awaitingAssets).success).toBe(true);
  });

  it('rejects unknown strict fields and malformed nested values', () => {
    const unknownMetadata = {
      ...createCompleteState(),
      metadata: {
        ...createCompleteState().metadata,
        unowned: true,
      },
    };
    const malformedDraft = {
      ...createCompleteState(),
      draft: {
        current: {
          ...initialDraft,
          wordCount: 'two',
        },
        history: [],
      },
    };

    expect(PipelineStateSchema.safeParse(unknownMetadata).success).toBe(false);
    expect(PipelineStateSchema.safeParse(malformedDraft).success).toBe(false);
  });
});

describe('state ownership', () => {
  it('encodes the frozen ownership table without a notification writer', () => {
    expect(STATE_FIELD_OWNERS.brief).toEqual(['sheet-reader']);
    expect(STATE_FIELD_OWNERS['metadata.sheetRowId']).toEqual(['sheet-reader']);
    expect(STATE_FIELD_OWNERS['metadata.status']).toEqual(['orchestrator']);
    expect(STATE_FIELD_OWNERS['review.loop.iteration']).toEqual(['orchestrator']);
    expect(STATE_FIELD_OWNERS['draft.current']).toEqual(['writer', 'humanizer', 'improver']);
    expect(STATE_FIELD_OWNERS['images.generated']).toEqual(['image-generator']);
    expect(STATE_FIELD_OWNERS['images.staged']).toEqual(['image-upload']);
    expect(STATE_FIELD_OWNERS['sanity.document']).toEqual(['sanity-builder']);
    expect(STATE_FIELD_OWNERS['metrics.costEvents']).toEqual(['moduleRunner']);
    expect(Object.values(STATE_FIELD_OWNERS).flat()).not.toContain('notify');
  });
});

describe('immutable state helpers', () => {
  it('returns new state for Sheet Reader and orchestrator-owned updates', () => {
    const state = createInitialState();
    const rowUpdated = setSheetRowId(state, 'row-1');
    const statusUpdated = setPipelineStatus(rowUpdated, 'needs_review');
    const loopUpdated = setReviewLoopIteration(statusUpdated, 2);

    expect(rowUpdated).not.toBe(state);
    expect(rowUpdated.metadata).not.toBe(state.metadata);
    expect(state.metadata.sheetRowId).toBe('');
    expect(statusUpdated.metadata.status).toBe('needs_review');
    expect(loopUpdated.review).toEqual({ loop: { iteration: 2 } });
    expect(statusUpdated.review).toBeUndefined();
  });

  it('retains every prior draft in ordered, attributed immutable history', () => {
    const initial = createInitialState();
    const writerState = replaceDraft(initial, 'writer', initialDraft, FIRST_TIMESTAMP);
    const humanizedState = replaceDraft(writerState, 'humanizer', humanizedDraft, SECOND_TIMESTAMP);
    const improvedState = replaceDraft(
      humanizedState,
      'improver',
      improvedDraft,
      '2026-07-22T12:02:00.000Z',
    );

    expect(writerState.draft).toEqual({ current: initialDraft, history: [] });
    expect(humanizedState.draft?.current).toEqual(humanizedDraft);
    expect(humanizedState.draft?.history).toEqual([
      { producedBy: 'humanizer', at: SECOND_TIMESTAMP, draft: initialDraft },
    ]);
    expect(improvedState.draft?.history).toEqual([
      { producedBy: 'humanizer', at: SECOND_TIMESTAMP, draft: initialDraft },
      {
        producedBy: 'improver',
        at: '2026-07-22T12:02:00.000Z',
        draft: humanizedDraft,
      },
    ]);
    expect(writerState.draft?.history).toEqual([]);
    expect(humanizedState.draft?.history).toHaveLength(1);
  });

  it('appends audit records without mutating source state and recomputes cost totals', () => {
    const state = createInitialState();
    const firstEvent = createCostEvent(state.metadata.runId, 0.01);
    const secondEvent = { ...createCostEvent(state.metadata.runId, 0.02), attemptNumber: 2 };
    const error: ErrorRecord = {
      runId: state.metadata.runId,
      module: 'research',
      errorClass: 'RetryableError',
      attemptNumber: 1,
      message: 'Retry me',
      timestamp: FIRST_TIMESTAMP,
      resolved: true,
    };
    const timing: TimingRecord = {
      runId: state.metadata.runId,
      module: 'research',
      attemptNumber: 1,
      startedAt: FIRST_TIMESTAMP,
      durationMs: 250,
    };

    const withFirstCost = appendCostEvent(state, firstEvent);
    const withSecondCost = appendCostEvent(withFirstCost, secondEvent);
    const withError = appendErrorRecord(withSecondCost, error);
    const withTiming = appendTimingRecord(withError, timing);

    expect(state.metrics).toEqual({ costEvents: [], totalCostUsd: 0 });
    expect(withSecondCost.metrics.costEvents).toEqual([firstEvent, secondEvent]);
    expect(withSecondCost.metrics.totalCostUsd).toBeCloseTo(0.03);
    expect(withTiming.errors).toEqual([error]);
    expect(withTiming.timings).toEqual([timing]);
    expect(withError.errors).toEqual([error]);
  });

  it('rejects audit records from another run', () => {
    const state = createInitialState();

    expect(() => appendCostEvent(state, createCostEvent('other-run'))).toThrow(RangeError);
    expect(() =>
      appendErrorRecord(state, {
        runId: 'other-run',
        module: 'research',
        errorClass: 'FatalError',
        attemptNumber: 1,
        message: 'Nope',
        timestamp: FIRST_TIMESTAMP,
        resolved: false,
      }),
    ).toThrow(RangeError);
    expect(() =>
      appendTimingRecord(state, {
        runId: 'other-run',
        module: 'research',
        attemptNumber: 1,
        startedAt: FIRST_TIMESTAMP,
        durationMs: 1,
      }),
    ).toThrow(RangeError);
  });
});

describe('legacy flat-state migration', () => {
  it('migrates every documented flat alias to the nested contract', () => {
    const state = createCompleteState();
    const legacy = {
      ...state,
      contentPlan: state.planning,
      seoPlan: state.seo,
      draft: state.draft?.current,
      technicalReview: state.review?.technical,
      seoReview: state.review?.seo,
      reviewLoop: state.review?.loop,
      qaGate: state.qa,
      imagePlan: state.images?.plan,
      generatedImages: state.images?.generated,
      imageValidation: state.images?.validation,
      uploadedImages: state.images?.uploaded,
      resolvedLinks: state.sanity?.resolvedLinks,
      portableText: state.sanity?.portableText,
      faq: state.sanity?.faq,
      structuredDataCheck: state.sanity?.structuredDataCheck,
      sanityDocument: state.sanity?.document,
      publishResult: state.publishing,
    } as Record<string, unknown>;
    delete legacy.planning;
    delete legacy.seo;
    delete legacy.review;
    delete legacy.qa;
    delete legacy.images;
    delete legacy.sanity;
    delete legacy.publishing;

    const migrated = migrateLegacyPipelineState(legacy);
    const parsed = PipelineStateSchema.parse(migrated);

    expect(parsed.planning).toEqual(state.planning);
    expect(parsed.seo).toEqual(state.seo);
    expect(parsed.draft).toEqual({ current: state.draft?.current, history: [] });
    expect(parsed.review).toEqual(state.review);
    expect(parsed.qa).toEqual(state.qa);
    expect(parsed.images).toEqual(state.images);
    expect(parsed.sanity).toEqual(state.sanity);
    expect(parsed.publishing).toEqual(state.publishing);
  });

  it('rejects conflicting legacy and nested write paths', () => {
    const state = createCompleteState();
    const conflicting = {
      ...state,
      contentPlan: state.planning,
    };

    expect(() => migrateLegacyPipelineState(conflicting)).toThrow(/conflicts/);
  });
});
