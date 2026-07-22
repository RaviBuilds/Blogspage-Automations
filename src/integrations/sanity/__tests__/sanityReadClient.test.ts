/**
 * Tests for SanityReadClient.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SanityReadClient, createSanityReadClient } from '../sanityReadClient.js';

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

// Mock @sanity/client
vi.mock('@sanity/client', () => ({
  createClient: vi.fn(() => ({
    fetch: mockFetch,
  })),
}));

describe('SanityReadClient', () => {
  let client: SanityReadClient;

  const config = {
    projectId: 'test-project',
    dataset: 'test-dataset',
    apiVersion: '2026-01-01',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SanityReadClient(config);
  });

  describe('isSlugUnique', () => {
    it('returns true when slug is unique', async () => {
      mockFetch.mockResolvedValueOnce(0);

      const result = await client.isSlugUnique('unique-slug');

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('count'), {
        slug: 'unique-slug',
      });
    });

    it('returns false when slug exists', async () => {
      mockFetch.mockResolvedValueOnce(1);

      const result = await client.isSlugUnique('existing-slug');

      expect(result).toBe(false);
    });

    it('handles multiple existing posts', async () => {
      mockFetch.mockResolvedValueOnce(3);

      const result = await client.isSlugUnique('popular-slug');

      expect(result).toBe(false);
    });
  });

  describe('findPostBySlug', () => {
    it('returns post when found', async () => {
      const mockPost = {
        _id: 'post-123',
        _type: 'post',
        title: 'Test Post',
        slug: { current: 'test-post' },
        publishedAt: '2026-01-01T00:00:00Z',
      };
      mockFetch.mockResolvedValueOnce(mockPost);

      const result = await client.findPostBySlug('test-post');

      expect(result).toEqual(mockPost);
    });

    it('returns null when not found', async () => {
      mockFetch.mockResolvedValueOnce(null);

      const result = await client.findPostBySlug('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('fetchPublishedPosts', () => {
    it('returns published posts', async () => {
      const mockPosts = [
        {
          _id: 'post-1',
          _type: 'post',
          title: 'Post 1',
          slug: { current: 'post-1' },
        },
        {
          _id: 'post-2',
          _type: 'post',
          title: 'Post 2',
          slug: { current: 'post-2' },
        },
      ];
      mockFetch.mockResolvedValueOnce(mockPosts);

      const result = await client.fetchPublishedPosts(10);

      expect(result).toEqual(mockPosts);
      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), { limit: 10 });
    });

    it('uses default limit', async () => {
      mockFetch.mockResolvedValueOnce([]);

      await client.fetchPublishedPosts();

      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), { limit: 100 });
    });

    it('returns empty array when no posts', async () => {
      mockFetch.mockResolvedValueOnce([]);

      const result = await client.fetchPublishedPosts();

      expect(result).toEqual([]);
    });
  });

  describe('searchPosts', () => {
    it('searches posts by term', async () => {
      const mockPosts = [
        {
          _id: 'post-1',
          _type: 'post',
          title: 'React Tutorial',
          slug: { current: 'react-tutorial' },
        },
      ];
      mockFetch.mockResolvedValueOnce(mockPosts);

      const result = await client.searchPosts('react', 5);

      expect(result).toEqual(mockPosts);
      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), {
        searchTerm: 'react*',
        limit: 5,
      });
    });
  });

  describe('fetchAuthor', () => {
    it('fetches author by ID', async () => {
      const mockAuthor = {
        _id: 'author-ravi',
        _type: 'author',
        name: 'Ravi',
        slug: { current: 'ravi' },
      };
      mockFetch.mockResolvedValueOnce(mockAuthor);

      const result = await client.fetchAuthor('author-ravi');

      expect(result).toEqual(mockAuthor);
    });

    it('uses default author ID', async () => {
      mockFetch.mockResolvedValueOnce(null);

      await client.fetchAuthor();

      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), {
        authorId: 'author-ravi',
      });
    });

    it('returns null when not found', async () => {
      mockFetch.mockResolvedValueOnce(null);

      const result = await client.fetchAuthor('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('fetchCategories', () => {
    it('returns all categories', async () => {
      const mockCategories = [
        { _id: 'category-1', _type: 'category', title: 'Tech', slug: { current: 'tech' } },
        { _id: 'category-2', _type: 'category', title: 'AI', slug: { current: 'ai' } },
      ];
      mockFetch.mockResolvedValueOnce(mockCategories);

      const result = await client.fetchCategories();

      expect(result).toEqual(mockCategories);
    });
  });

  describe('fetchCategory', () => {
    it('fetches category by ID', async () => {
      const mockCategory = {
        _id: 'category-1',
        _type: 'category',
        title: 'Tech Insights',
        slug: { current: 'tech-insights' },
      };
      mockFetch.mockResolvedValueOnce(mockCategory);

      const result = await client.fetchCategory('category-1');

      expect(result).toEqual(mockCategory);
    });

    it('returns null when not found', async () => {
      mockFetch.mockResolvedValueOnce(null);

      const result = await client.fetchCategory('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('fetch (raw query)', () => {
    it('executes raw GROQ query', async () => {
      mockFetch.mockResolvedValueOnce([{ _id: 'doc-1' }]);

      const result = await client.fetch('*[_type == "post"][0...1]{ _id }');

      expect(result).toEqual([{ _id: 'doc-1' }]);
    });

    it('passes query parameters', async () => {
      mockFetch.mockResolvedValueOnce([]);

      await client.fetch('*[_type == $type]', { type: 'post' });

      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), { type: 'post' });
    });
  });
});

describe('createSanityReadClient', () => {
  it('creates a SanityReadClient instance', () => {
    const client = createSanityReadClient({
      projectId: 'test',
      dataset: 'test',
      apiVersion: '2026-01-01',
    });

    expect(client).toBeInstanceOf(SanityReadClient);
  });
});
