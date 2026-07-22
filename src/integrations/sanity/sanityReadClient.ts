/**
 * Sanity read client for querying existing content.
 *
 * This client provides read-only access to the Sanity Content Lake for:
 * - Checking slug uniqueness
 * - Fetching existing posts for internal linking
 * - Resolving author and category references
 *
 * @see architecture/03-module-flow.md - Internal Link Generator, SEO Planner
 * @see architecture/12-future-roadmap.md - Phase 5 scope
 */

import { createClient, type QueryParams, type SanityClient } from '@sanity/client';
import { ProviderError } from '@/core/errors.js';

/** Configuration for the Sanity read client. */
export interface SanityReadConfig {
  readonly projectId: string;
  readonly dataset: string;
  readonly apiVersion: string;
  /** Optional: use CDN for reads (default: true for reads). */
  readonly useCdn?: boolean;
}

/**
 * Post document fields needed for internal linking and slug checking.
 */
export interface PostReference {
  readonly _id: string;
  readonly _type: 'post';
  readonly title: string;
  readonly slug: { current: string };
  readonly publishedAt?: string;
}

/**
 * Author document for reference resolution.
 */
export interface AuthorReference {
  readonly _id: string;
  readonly _type: 'author';
  readonly name: string;
  readonly slug: { current: string };
}

/**
 * Category document for reference resolution.
 */
export interface CategoryReference {
  readonly _id: string;
  readonly _type: 'category';
  readonly title: string;
  readonly slug: { current: string };
}

/**
 * Read-only client for Sanity Content Lake queries.
 *
 * All methods are read-only and cache results where appropriate.
 */
export class SanityReadClient {
  private readonly client: SanityClient;
  private readonly config: SanityReadConfig;

  constructor(config: SanityReadConfig) {
    this.config = config;
    this.client = createClient({
      projectId: config.projectId,
      dataset: config.dataset,
      apiVersion: config.apiVersion,
      useCdn: config.useCdn ?? true, // Default to CDN for reads
    });
  }

  /**
   * Checks if a slug is unique among published posts.
   *
   * @param slug - The slug to check.
   * @returns True if the slug is unique (no existing post with this slug).
   */
  async isSlugUnique(slug: string): Promise<boolean> {
    try {
      const query = `count(*[_type == "post" && slug.current == $slug])`;
      const count = await this.client.fetch<number>(query, { slug });
      return count === 0;
    } catch (error) {
      throw new ProviderError('sanity-read', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Finds an existing post by slug.
   *
   * @param slug - The slug to search for.
   * @returns The post reference, or null if not found.
   */
  async findPostBySlug(slug: string): Promise<PostReference | null> {
    try {
      const query = `
        *[_type == "post" && slug.current == $slug][0] {
          _id,
          _type,
          title,
          slug,
          publishedAt
        }
      `;
      return await this.client.fetch<PostReference | null>(query, { slug });
    } catch (error) {
      throw new ProviderError('sanity-read', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Fetches all published posts for internal linking.
   *
   * @param limit - Maximum number of posts to return (default: 100).
   * @returns Array of post references.
   */
  async fetchPublishedPosts(limit: number = 100): Promise<PostReference[]> {
    try {
      const query = `
        *[_type == "post" && defined(publishedAt)] | order(publishedAt desc) [0...$limit] {
          _id,
          _type,
          title,
          slug,
          publishedAt
        }
      `;
      return await this.client.fetch<PostReference[]>(query, { limit });
    } catch (error) {
      throw new ProviderError('sanity-read', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Searches for posts matching a title or keyword.
   *
   * @param searchTerm - The search term.
   * @param limit - Maximum results to return (default: 10).
   * @returns Array of matching post references.
   */
  async searchPosts(searchTerm: string, limit: number = 10): Promise<PostReference[]> {
    try {
      const query = `
        *[_type == "post" && (
          title match $searchTerm ||
          pt::text(content) match $searchTerm ||
          seoKeywords[] match $searchTerm
        )] | order(publishedAt desc) [0...$limit] {
          _id,
          _type,
          title,
          slug,
          publishedAt
        }
      `;
      return await this.client.fetch<PostReference[]>(query, {
        searchTerm: `${searchTerm}*`,
        limit,
      });
    } catch (error) {
      throw new ProviderError('sanity-read', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Fetches the default author reference.
   *
   * @param authorId - The author ID (default: 'author-ravi').
   * @returns The author reference, or null if not found.
   */
  async fetchAuthor(authorId: string = 'author-ravi'): Promise<AuthorReference | null> {
    try {
      const query = `
        *[_type == "author" && _id == $authorId][0] {
          _id,
          _type,
          name,
          slug
        }
      `;
      return await this.client.fetch<AuthorReference | null>(query, { authorId });
    } catch (error) {
      throw new ProviderError('sanity-read', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Fetches all category references.
   *
   * @returns Array of category references.
   */
  async fetchCategories(): Promise<CategoryReference[]> {
    try {
      const query = `
        *[_type == "category"] | order(title asc) {
          _id,
          _type,
          title,
          slug
        }
      `;
      return await this.client.fetch<CategoryReference[]>(query);
    } catch (error) {
      throw new ProviderError('sanity-read', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Fetches a category by ID.
   *
   * @param categoryId - The category ID.
   * @returns The category reference, or null if not found.
   */
  async fetchCategory(categoryId: string): Promise<CategoryReference | null> {
    try {
      const query = `
        *[_type == "category" && _id == $categoryId][0] {
          _id,
          _type,
          title,
          slug
        }
      `;
      return await this.client.fetch<CategoryReference | null>(query, { categoryId });
    } catch (error) {
      throw new ProviderError('sanity-read', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Executes a raw GROQ query.
   *
   * @param query - The GROQ query string.
   * @param params - Optional query parameters.
   * @returns The query result.
   */
  async fetch<T = unknown>(query: string, params?: QueryParams): Promise<T> {
    try {
      return params ? await this.client.fetch<T>(query, params) : await this.client.fetch<T>(query);
    } catch (error) {
      throw new ProviderError('sanity-read', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Gets the underlying Sanity client for advanced use cases.
   */
  getRawClient(): SanityClient {
    return this.client;
  }

  /**
   * Determines if an error is retryable.
   */
  private isRetryable(error: unknown): boolean {
    if (error instanceof Error) {
      // Rate limit or server errors
      if (error.message.includes('429') || error.message.includes('503')) {
        return true;
      }
      // Network errors
      if (error.message.includes('ECONNRESET') || error.message.includes('ETIMEDOUT')) {
        return true;
      }
      // Sanity-specific errors
      const sanityError = error as { statusCode?: number };
      if (sanityError.statusCode === 429 || sanityError.statusCode === 503) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Creates a Sanity read client from configuration.
 */
export function createSanityReadClient(config: SanityReadConfig): SanityReadClient {
  return new SanityReadClient(config);
}
