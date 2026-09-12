/** Tests for the attach-images human-in-the-loop gateway. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FatalError, ValidationError } from '@/core/errors.js';
import { createInitialState, setPipelineStatus, type ImagePlan } from '@/core/state.js';
import { StateStore } from '@/core/stateStore.js';

import {
  AttachArgsSchema,
  attachImages,
  stagingDirFor,
  type AttachSummary,
} from '../attachImages.js';

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

const HERO_BYTES = png(1200, 630);
const INLINE_BYTES = png(800, 600);

const PLAN: ImagePlan = {
  images: [
    {
      id: 'hero',
      role: 'hero',
      prompt: 'Hotel lobby',
      altTextDraft: 'Hotel lobby room availability matrix',
      aspectRatio: '1200x630',
    },
    {
      id: 'inline-1',
      role: 'inline',
      prompt: 'Booking flow',
      altTextDraft: 'Direct booking flow diagram',
      aspectRatio: '4:3',
      placementMarkerId: 'inline-1',
    },
  ],
};

async function createPausedStateStore(storageDir: string): Promise<StateStore> {
  const store = new StateStore({ storageDir });
  await store.initialize();
  const base = createInitialState({ sheetRowId: 'row-1' });
  const paused = setPipelineStatus(
    {
      ...base,
      brief: { topic: 'Direct booking', sheetRowId: 'row-1' },
      images: { plan: PLAN },
    },
    'awaiting_assets',
  );
  await store.save(paused);
  return store;
}

async function writeAttachDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'hero.png'), HERO_BYTES);
  await writeFile(join(dir, 'inline-1.png'), INLINE_BYTES);
}

describe('attach-images', () => {
  it('stages every planned image, copies files, and re-arms the run to running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attach-'));
    const storageDir = join(root, 'storage');
    const attachDir = join(root, 'dropbox');
    const stagingBase = join(root, 'staging');

    try {
      const store = await createPausedStateStore(storageDir);
      await writeAttachDir(attachDir);
      const runId = (await store.listRuns())[0]!;

      const summary: AttachSummary = await attachImages(
        { runId, dir: attachDir },
        { stateStore: store, stagingBase },
      );

      expect(summary.status).toBe('success');
      expect(summary.stagedCount).toBe(2);
      expect(summary.stagingDir).toBe(stagingDirFor(runId, stagingBase));
      expect(summary.attachedImages).toEqual(['hero.png', 'inline-1.png']);

      const updated = await store.load(runId);
      expect(updated?.metadata.status).toBe('running');
      expect(updated?.images?.staged).toHaveLength(2);
      const staged = updated?.images?.staged ?? [];
      expect(staged[0]?.attachedBy).toBe('cli:attach-images');
      expect(staged.map((entry) => entry.imageId).sort()).toEqual(['hero', 'inline-1']);

      // Files were actually copied into the staging folder.
      const copiedHero = await readFile(join(summary.stagingDir, 'hero.png'));
      expect(copiedHero).toEqual(Buffer.from(HERO_BYTES));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails when the run does not exist', async () => {
    const store = new StateStore({ storageDir: await mkdtemp(join(tmpdir(), 'attach-')) });
    await expect(
      attachImages({ runId: 'missing-run', dir: '/tmp' }, { stateStore: store }),
    ).rejects.toBeInstanceOf(FatalError);
  });

  it('fails when the run is not awaiting_assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attach-'));
    try {
      const store = new StateStore({ storageDir: join(root, 'storage') });
      await store.initialize();
      const running = createInitialState({ sheetRowId: 'row-1' });
      await store.save(running);

      await expect(
        attachImages(
          { runId: running.metadata.runId, dir: join(root, 'dropbox') },
          { stateStore: store },
        ),
      ).rejects.toThrow(/awaiting_assets/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails when there is no images.plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attach-'));
    try {
      const store = new StateStore({ storageDir: join(root, 'storage') });
      await store.initialize();
      const paused = setPipelineStatus(
        createInitialState({ sheetRowId: 'row-1' }),
        'awaiting_assets',
      );
      await store.save(paused);

      await expect(
        attachImages(
          { runId: paused.metadata.runId, dir: join(root, 'dropbox') },
          { stateStore: store },
        ),
      ).rejects.toThrow(/no images.plan/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects files that do not match any planned image', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attach-'));
    try {
      const store = await createPausedStateStore(join(root, 'storage'));
      const attachDir = join(root, 'dropbox');
      await mkdir(attachDir, { recursive: true });
      await writeFile(join(attachDir, 'unexpected.png'), HERO_BYTES);

      const runId = (await store.listRuns())[0]!;
      await expect(attachImages({ runId, dir: attachDir }, { stateStore: store })).rejects.toThrow(
        /do not match any image/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a folder missing a planned image', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attach-'));
    try {
      const store = await createPausedStateStore(join(root, 'storage'));
      const attachDir = join(root, 'dropbox');
      await mkdir(attachDir, { recursive: true });
      await writeFile(join(attachDir, 'hero.png'), HERO_BYTES); // no inline-1.png

      const runId = (await store.listRuns())[0]!;
      await expect(attachImages({ runId, dir: attachDir }, { stateStore: store })).rejects.toThrow(
        /Missing file/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects two files that resolve to the same planned image', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attach-'));
    try {
      const store = await createPausedStateStore(join(root, 'storage'));
      const attachDir = join(root, 'dropbox');
      await mkdir(attachDir, { recursive: true });
      await writeFile(join(attachDir, 'hero.png'), HERO_BYTES);
      await writeFile(join(attachDir, 'hero.jpg'), HERO_BYTES);
      await writeFile(join(attachDir, 'inline-1.png'), INLINE_BYTES);

      const runId = (await store.listRuns())[0]!;
      await expect(attachImages({ runId, dir: attachDir }, { stateStore: store })).rejects.toThrow(
        /Multiple files match/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a matching file that is not a supported image', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attach-'));
    try {
      const store = await createPausedStateStore(join(root, 'storage'));
      const attachDir = join(root, 'dropbox');
      await mkdir(attachDir, { recursive: true });
      await writeFile(join(attachDir, 'hero.png'), Buffer.from('not an image'));

      const runId = (await store.listRuns())[0]!;
      await expect(
        attachImages({ runId, dir: attachDir }, { stateStore: store }),
      ).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('AttachArgs schema', () => {
  it('parses runId and dir flags', () => {
    expect(AttachArgsSchema.parse({ runId: 'run-1', dir: '/tmp/img' })).toEqual({
      runId: 'run-1',
      dir: '/tmp/img',
    });
  });

  it('rejects missing args', () => {
    expect(() => AttachArgsSchema.parse({ runId: 'run-1' })).toThrow();
    expect(() => AttachArgsSchema.parse({ dir: '/tmp' })).toThrow();
  });
});
