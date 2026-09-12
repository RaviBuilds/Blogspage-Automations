/** Tests for the Portable Text Converter module and its pipeline adapters. */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/core/errors.js';
import { createModuleRegistry, ModuleRunner, type ModuleRunnerClock } from '@/core/moduleRunner.js';
import {
  createInitialState,
  type DraftSection,
  type ImagesSection,
  type PipelineState,
  type ResolvedLink,
} from '@/core/state.js';
import { FakeLLMProvider } from '@/providers/llm/FakeLLMProvider.js';
import type { PromptSet } from '@/prompts/registry.js';

const MOCK_PROMPT_SET: PromptSet = Object.freeze({
  system: 'You are the portable text converter.',
  user: 'Convert the content.',
  promptVersion: 'abc1234',
});

import {
  buildPortableText,
  buildPortableTextRequest,
  createPortableTextModule,
  createPortableTextModuleBinding,
  portableTextModuleMetadata,
  type PortableTextModuleServices,
  type PortableTextRequest,
} from '../portableTextModule.js';

const DRAFT_WITH_MARKERS: DraftSection = {
  current: {
    markdown: 'Intro paragraph. [[link: link-1]] continue.\n\nHello [[image: inline-1]] world.',
    wordCount: 20,
    linkMarkers: [{ markerId: 'link-1', anchorTextHint: 'direct booking guide' }],
    imageMarkers: [{ markerId: 'inline-1', role: 'inline', descriptionHint: 'Diagram' }],
  },
  history: [],
};

const RESOLVED_LINKS: readonly ResolvedLink[] = [
  {
    markerId: 'link-1',
    targetPostId: 'post-direct-booking',
    targetSlug: 'why-direct-booking',
    anchorText: 'direct booking guide',
  },
];

const UPLOADED_IMAGES: ImagesSection = {
  plan: {
    images: [
      {
        id: 'inline-1',
        role: 'inline',
        prompt: 'Diagram of the direct booking flow',
        altTextDraft: 'Direct booking flow diagram',
        aspectRatio: '4:3',
        placementMarkerId: 'inline-1',
      },
    ],
  },
  uploaded: [
    {
      imageId: 'inline-1',
      role: 'inline',
      assetId: 'image-hash-aabbcc-800x600-png',
      altText: 'Direct booking flow diagram',
      placementMarkerId: 'inline-1',
    },
  ],
};

class FakeClock implements ModuleRunnerClock {
  public now(): Date {
    return new Date('2026-07-25T10:00:00.000Z');
  }

  public monotonicNow(): number {
    return 0;
  }
}

function createServices(): PortableTextModuleServices {
  return {
    llmProvider: new FakeLLMProvider(),
    promptRegistry: {
      get: () => Promise.resolve(MOCK_PROMPT_SET),
    },
  };
}

function createState(): PipelineState {
  return {
    ...createInitialState(),
    draft: DRAFT_WITH_MARKERS,
    images: UPLOADED_IMAGES,
    sanity: { resolvedLinks: RESOLVED_LINKS },
  };
}
describe('portableTextModuleMetadata', () => {
  it('has the correct module key and dependencies', () => {
    expect(portableTextModuleMetadata.key).toBe('portable-text');
    expect(portableTextModuleMetadata.dependencies).toEqual(['internal-links', 'image-upload']);
  });
});

describe('buildPortableText', () => {
  it('substitutes uploaded images and resolved internal links into portable text', () => {
    const content = buildPortableText({
      draft: DRAFT_WITH_MARKERS,
      images: UPLOADED_IMAGES,
      resolvedLinks: RESOLVED_LINKS,
    });

    expect(content.length).toBeGreaterThan(0);

    const imageBlock = content.find(
      (block) => block._type === 'image' && block.asset._ref === 'image-hash-aabbcc-800x600-png',
    ) as { _type: 'image'; asset: { _ref: string }; alt: string } | undefined;
    expect(imageBlock).toBeDefined();
    if (imageBlock) {
      expect(imageBlock._type).toBe('image');
      expect(imageBlock.alt).toBe('Direct booking flow diagram');
    }

    const linkParagraph = content.find((block) => block._type === 'block');
    const firstSpan = linkParagraph?.children?.find((span) => span.marks.length > 0);
    expect(firstSpan?.marks[0]).toMatch(/^internal\d+$/);
  });

  it('fails when an image marker has no matching uploaded asset', () => {
    expect(() =>
      buildPortableText({
        draft: DRAFT_WITH_MARKERS,
        images: { plan: { images: [] } },
        resolvedLinks: RESOLVED_LINKS,
      }),
    ).toThrow(ValidationError);
  });

  it('drops unresolved link markers instead of failing', () => {
    const content = buildPortableText({
      draft: DRAFT_WITH_MARKERS,
      images: UPLOADED_IMAGES,
      resolvedLinks: [],
    });
    const text = JSON.stringify(content);
    expect(text).not.toContain('[[link:');
    expect(content.length).toBeGreaterThan(0);
  });
});

describe('portableTextModule via the orchestrator binding', () => {
  it('writes sanity.portableText through the module runner', async () => {
    const services = createServices();
    const module = createPortableTextModule();
    const registry = createModuleRegistry<PortableTextModuleServices>().register(module);
    const state = createState();
    const binding = createPortableTextModuleBinding();

    const input = binding.createInput(state, {} as never);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as PortableTextRequest,
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const newState = binding.applyOutput(state, result.output, {} as never);
    expect(newState.sanity?.portableText?.length).toBeGreaterThan(0);
  });

  it('requires a draft', () => {
    expect(() => buildPortableTextRequest(createInitialState())).toThrow(ValidationError);
  });
});
