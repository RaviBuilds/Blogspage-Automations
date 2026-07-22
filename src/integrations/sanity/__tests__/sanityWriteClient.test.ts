/**
 * Tests for SanityWriteClient.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SanityWriteClient,
  createSanityWriteClient,
  type SanityWriteConfig,
} from '../sanityWriteClient.js';
import { FatalError } from '@/core/errors.js';

const sanityMocks = vi.hoisted(() => ({
  assets: {
    upload: vi.fn(),
  },
  create: vi.fn(),
  createIfNotExists: vi.fn(),
  patch: vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      commit: vi.fn(),
    }),
  }),
  delete: vi.fn(),
  transaction: vi.fn().mockReturnValue({
    create: vi.fn().mockReturnThis(),
    patch: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    commit: vi.fn(),
  }),
  fetch: vi.fn(),
  getDocument: vi.fn(),
}));

vi.mock('@sanity/client', () => ({
  createClient: vi.fn(() => sanityMocks),
}));

describe('SanityWriteClient', () => {
  let client: SanityWriteClient;

  const config: SanityWriteConfig = {
    projectId: 'test-project',
    dataset: 'test-dataset',
    apiVersion: '2026-01-01',
    token: 'test-token',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SanityWriteClient(config);
  });

  describe('uploadImageAsset', () => {
    it('uploads an image asset', async () => {
      const mockAsset = {
        _id: 'image-abc123-1200x800-jpg',
        url: 'https://cdn.sanity.io/images/test-project/test-dataset/abc123-1200x800.jpg',
        metadata: {
          dimensions: { width: 1200, height: 800 },
        },
      };
      sanityMocks.assets.upload.mockResolvedValueOnce(mockAsset);

      const buffer = Buffer.from('fake-image-data');
      const result = await client.uploadImageAsset(buffer, 'test.jpg');

      expect(result.assetId).toBe('image-abc123-1200x800-jpg');
      expect(result.width).toBe(1200);
      expect(result.height).toBe(800);
    });

    it('handles missing dimensions gracefully', async () => {
      const mockAsset = {
        _id: 'image-abc123-jpg',
        url: 'https://cdn.sanity.io/images/test.jpg',
        metadata: {},
      };
      sanityMocks.assets.upload.mockResolvedValueOnce(mockAsset);

      const buffer = Buffer.from('fake-image-data');
      const result = await client.uploadImageAsset(buffer, 'test.jpg');

      expect(result.width).toBe(0);
      expect(result.height).toBe(0);
    });
  });

  describe('createPost', () => {
    const validDocument = {
      _type: 'post',
      title: 'Test Post',
      slug: { _type: 'slug', current: 'test-post' },
      excerpt: 'Test excerpt for the post',
      author: { _type: 'reference', _ref: 'author-ravi' },
      publishedAt: '2026-01-01T00:00:00Z',
      categories: [],
      content: [],
    };

    it('creates a new post', async () => {
      sanityMocks.fetch.mockResolvedValueOnce(null); // No existing post
      sanityMocks.create.mockResolvedValueOnce({
        _id: 'post-123',
        ...validDocument,
      });

      const result = await client.createPost(validDocument);

      expect(result.documentId).toBe('post-123');
      expect(result.slug).toBe('test-post');
    });

    it('returns existing post if slug already exists (idempotency)', async () => {
      sanityMocks.fetch.mockResolvedValueOnce({
        _id: 'existing-post-123',
        slug: { current: 'test-post' },
      });

      const result = await client.createPost(validDocument);

      expect(result.documentId).toBe('existing-post-123');
      expect(sanityMocks.create).not.toHaveBeenCalled();
    });

    it('throws FatalError for missing slug', async () => {
      const invalidDocument = {
        _type: 'post',
        title: 'Test Post',
      };

      await expect(client.createPost(invalidDocument)).rejects.toThrow(FatalError);
    });
  });

  describe('createOrUpdate', () => {
    it('creates if not exists', async () => {
      sanityMocks.createIfNotExists.mockResolvedValueOnce({
        _id: 'doc-123',
        title: 'Test',
      });

      const result = await client.createOrUpdate('doc-123', {
        _type: 'post',
        title: 'Test',
      });

      expect(result).toBe('doc-123');
    });
  });

  describe('patchDocument', () => {
    it('patches a document', async () => {
      await client.patchDocument('doc-123', { title: 'Updated' });

      expect(sanityMocks.patch).toHaveBeenCalledWith('doc-123');
    });
  });

  describe('deleteDocument', () => {
    it('deletes a document', async () => {
      await client.deleteDocument('doc-123');

      expect(sanityMocks.delete).toHaveBeenCalledWith('doc-123');
    });
  });

  describe('executeTransaction', () => {
    it('executes multiple operations in a transaction', async () => {
      const mockTransaction = {
        create: vi.fn().mockReturnThis(),
        patch: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        commit: vi.fn().mockResolvedValueOnce({}),
      };
      sanityMocks.transaction.mockReturnValueOnce(mockTransaction);

      const result = await client.executeTransaction([
        { type: 'create', document: { _type: 'post', title: 'New' } },
        { type: 'patch', documentId: 'doc-1', patches: { title: 'Updated' } },
        { type: 'delete', documentId: 'doc-2' },
      ]);

      expect(result).toBe(true);
      expect(mockTransaction.create).toHaveBeenCalled();
      expect(mockTransaction.patch).toHaveBeenCalled();
      expect(mockTransaction.delete).toHaveBeenCalled();
    });
  });

  describe('findPostBySlug', () => {
    it('finds a post by slug', async () => {
      sanityMocks.fetch.mockResolvedValueOnce({
        _id: 'post-123',
        slug: { current: 'test-post' },
      });

      const result = await client.findPostBySlug('test-post');

      expect(result?._id).toBe('post-123');
    });

    it('returns null when not found', async () => {
      sanityMocks.fetch.mockResolvedValueOnce(null);

      const result = await client.findPostBySlug('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('fetchDocument', () => {
    it('fetches a document by ID', async () => {
      sanityMocks.getDocument.mockResolvedValueOnce({
        _id: 'doc-123',
        title: 'Test',
      });

      const result = await client.fetchDocument('doc-123');

      expect(result?._id).toBe('doc-123');
    });

    it('returns null for 404', async () => {
      const error = new Error('Not found') as Error & { statusCode?: number };
      error.statusCode = 404;
      sanityMocks.getDocument.mockRejectedValueOnce(error);

      const result = await client.fetchDocument('non-existent');

      expect(result).toBeNull();
    });
  });
});

describe('createSanityWriteClient', () => {
  it('creates a SanityWriteClient instance', () => {
    const client = createSanityWriteClient({
      projectId: 'test',
      dataset: 'test',
      apiVersion: '2026-01-01',
      token: 'test-token',
    });

    expect(client).toBeInstanceOf(SanityWriteClient);
  });
});
