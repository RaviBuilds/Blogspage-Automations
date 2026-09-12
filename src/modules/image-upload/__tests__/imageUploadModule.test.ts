/** Tests for the deterministic Image Upload module and its pipeline adapters. */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/core/errors.js';
import { createModuleRegistry, ModuleRunner, type ModuleRunnerClock } from '@/core/moduleRunner.js';
import {
  createInitialState,
  type ImagePlan,
  type PipelineState,
  type StagedImage,
} from '@/core/state.js';
import { FakeLLMProvider } from '@/providers/llm/FakeLLMProvider.js';
import type { PromptSet } from '@/prompts/registry.js';

import {
  buildImageUploadRequest,
  createImageUploadModule,
  createImageUploadModuleBinding,
  imageUploadModuleMetadata,
  ImageUploadResultSchema,
  type ImageUploadModuleServices,
  type ImageUploadRequest,
  prepareUploadedImages,
} from '../imageUploadModule.js';

const MOCK_PROMPT_SET: PromptSet = Object.freeze({
  system: 'unused',
  user: 'unused',
  promptVersion: 'abc1234',
});

function png(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
  ]);
}

function gif(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...Buffer.from('GIF89a'),
    width & 0xff,
    (width >>> 8) & 0xff,
    height & 0xff,
    (height >>> 8) & 0xff,
  ]);
}

const heroBytes = png(1200, 630);
const inlineBytes = gif(320, 240);

const PLAN: ImagePlan = {
  images: [
    {
      id: 'hero',
      role: 'hero',
      prompt: 'A hotel lobby with a live room matrix screen',
      altTextDraft: 'Hotel lobby room availability matrix',
      aspectRatio: '1200x630',
    },
    {
      id: 'inline-1',
      role: 'inline',
      prompt: 'Flow diagram of direct booking',
      altTextDraft: 'Direct booking flow diagram',
      aspectRatio: '4:3',
      placementMarkerId: 'inline-1',
    },
  ],
};

function stagedFromPath(
  imageId: string,
  role: 'hero' | 'inline',
  path: string,
  contentType: string,
): StagedImage {
  return Object.freeze({
    imageId,
    role,
    localPath: path,
    contentType,
    attachedBy: 'cli:attach-images',
    attachedAt: '2026-07-25T10:00:00.000Z',
  });
}

class FakeClock implements ModuleRunnerClock {
  public now(): Date {
    return new Date('2026-07-25T10:00:00.000Z');
  }

  public monotonicNow(): number {
    return 0;
  }
}

function createServices(): ImageUploadModuleServices {
  return {
    llmProvider: new FakeLLMProvider(),
    promptRegistry: {
      get: () => Promise.resolve(MOCK_PROMPT_SET),
    },
  };
}

function createState(staged: readonly StagedImage[]): PipelineState {
  return {
    ...createInitialState(),
    images: {
      plan: PLAN,
      staged,
    },
  };
}

describe('imageUploadModuleMetadata', () => {
  it('has the correct module key and dependency', () => {
    expect(imageUploadModuleMetadata.key).toBe('image-upload');
    expect(imageUploadModuleMetadata.displayName).toBe('Image Upload');
    expect(imageUploadModuleMetadata.dependencies).toEqual(['image-planner']);
  });
});

describe('prepareUploadedImages', () => {
  it('validates staged files and produces deterministic Sanity-style asset references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'img-upload-'));
    try {
      const heroPath = join(directory, 'hero.png');
      const inlinePath = join(directory, 'inline-1.gif');
      await writeFile(heroPath, heroBytes);
      await writeFile(inlinePath, inlineBytes);

      const uploaded = await prepareUploadedImages(PLAN, [
        stagedFromPath('hero', 'hero', heroPath, 'image/png'),
        stagedFromPath('inline-1', 'inline', inlinePath, 'image/gif'),
      ]);

      expect(uploaded).toHaveLength(2);
      const hero = uploaded[0];
      expect(hero?.assetId).toBe(`image-${sha1Hex(heroBytes)}-1200x630-png`);
      expect(hero?.altText).toBe(PLAN.images[0]?.altTextDraft);
      const inline = uploaded[1];
      expect(inline?.assetId).toBe(`image-${sha1Hex(inlineBytes)}-320x240-gif`);
      expect(inline?.placementMarkerId).toBe('inline-1');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fetches and validates a staged image from a URL', async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from(heroBytes).toString('base64')}`;
    const uploaded = await prepareUploadedImages(PLAN, [
      Object.freeze({
        imageId: 'hero',
        role: 'hero',
        url: dataUrl,
        contentType: 'image/png',
        attachedBy: 'cli:attach-images',
        attachedAt: '2026-07-25T10:00:00.000Z',
      }),
    ]);

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]?.assetId).toBe(`image-${sha1Hex(heroBytes)}-1200x630-png`);
  });

  it('rejects a staged image with no matching plan entry', async () => {
    await expect(
      prepareUploadedImages(PLAN, [
        stagedFromPath('mystery', 'inline', '/tmp/does-not-matter.png', 'image/png'),
      ]),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a staged image whose role mismatches the plan', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'img-upload-'));
    try {
      const path = join(directory, 'hero.png');
      await writeFile(path, heroBytes);
      await expect(
        prepareUploadedImages(PLAN, [stagedFromPath('hero', 'inline', path, 'image/png')]),
      ).rejects.toThrow(/role/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a staged image with neither a local path nor a URL', async () => {
    await expect(
      prepareUploadedImages(PLAN, [
        Object.freeze({
          imageId: 'hero',
          role: 'hero' as const,
          contentType: 'image/png',
          attachedBy: 'cli:attach-images',
          attachedAt: '2026-07-25T10:00:00.000Z',
        }),
      ]),
    ).rejects.toThrow(/exactly one of localPath or url/);
  });

  it('rejects a staged file that is not a supported image', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'img-upload-'));
    try {
      const path = join(directory, 'hero.png');
      await writeFile(path, Buffer.from('not an image at all'));
      await expect(
        prepareUploadedImages(PLAN, [stagedFromPath('hero', 'hero', path, 'image/png')]),
      ).rejects.toThrow(/not a supported image/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns an empty result when nothing is staged', async () => {
    await expect(prepareUploadedImages(PLAN, [])).resolves.toEqual([]);
  });
});

describe('imageUploadModule via the orchestrator binding', () => {
  it('writes images.uploaded through the module runner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'img-upload-'));
    try {
      const heroPath = join(directory, 'hero.png');
      await writeFile(heroPath, heroBytes);

      const services = createServices();
      const module = createImageUploadModule();
      const registry = createModuleRegistry<ImageUploadModuleServices>().register(module);
      const state = createState([stagedFromPath('hero', 'hero', heroPath, 'image/png')]);
      const binding = createImageUploadModuleBinding();

      const input = binding.createInput(state, {} as never);
      const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
        module,
        input as ImageUploadRequest,
        state,
        services,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const newState = binding.applyOutput(state, result.output, {} as never);
      expect(newState.images?.uploaded).toHaveLength(1);
      expect(newState.images?.uploaded?.[0]?.imageId).toBe('hero');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not erase prior uploads when the result is empty', () => {
    const state = createState([]);
    const binding = createImageUploadModuleBinding();
    const unchanged = binding.applyOutput(state, { uploaded: [] }, {} as never);
    expect(unchanged.images?.uploaded).toBeUndefined();
  });

  it('requires images.plan in the request builder', () => {
    expect(() => buildImageUploadRequest({ ...createInitialState() })).toThrow(ValidationError);
  });
});

describe('ImageUploadResultSchema', () => {
  it('validates an upload result', () => {
    const parsed = ImageUploadResultSchema.safeParse({
      uploaded: [
        { imageId: 'hero', role: 'hero', assetId: 'image-abc-1200x630-png', altText: 'A' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an upload result with a missing alt text', () => {
    const parsed = ImageUploadResultSchema.safeParse({
      uploaded: [{ imageId: 'hero', role: 'hero', assetId: 'image-abc-1200x630-png' }],
    });
    expect(parsed.success).toBe(false);
  });
});

function sha1Hex(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}
