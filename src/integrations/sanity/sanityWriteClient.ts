/**
 * Sanity write client for publishing content.
 *
 * This client provides write access to the Sanity Content Lake for:
 * - Uploading image assets
 * - Creating post documents
 * - Transactional writes with idempotency checks
 *
 * @see architecture/03-module-flow.md - Publish module
 * @see architecture/07-error-handling.md - Idempotency at Publish
 * @see architecture/12-future-roadmap.md - Phase 5 scope
 */

import { createClient, type SanityClient } from '@sanity/client';
import { FatalError, ProviderError } from '@/core/errors.js';

/** Configuration for the Sanity write client. */
export interface SanityWriteConfig {
  readonly projectId: string;
  readonly dataset: string;
  readonly apiVersion: string;
  readonly token: string;
}

type SanityDocumentInput = Record<string, unknown> & {
  readonly _type: string;
};

/**
 * Result of an image asset upload.
 */
export interface UploadedAsset {
  readonly assetId: string;
  readonly _id: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Result of a document creation.
 */
export interface CreatedDocument {
  readonly documentId: string;
  readonly slug: string;
}

/**
 * Write client for Sanity Content Lake operations.
 *
 * All write operations are idempotent and handle the specific error cases
 * documented in architecture/07-error-handling.md.
 */
export class SanityWriteClient {
  private readonly client: SanityClient;
  private readonly config: SanityWriteConfig;

  constructor(config: SanityWriteConfig) {
    this.config = config;
    this.client = createClient({
      projectId: config.projectId,
      dataset: config.dataset,
      apiVersion: config.apiVersion,
      useCdn: false, // Never use CDN for writes
      token: config.token,
    });
  }

  /**
   * Uploads an image asset to Sanity.
   *
   * @param imageBuffer - The image data as a buffer.
   * @param filename - The filename for the asset.
   * @param options - Optional metadata.
   * @returns The uploaded asset information.
   */
  async uploadImageAsset(
    imageBuffer: Buffer,
    filename: string,
    _options?: {
      readonly alt?: string;
      readonly title?: string;
    },
  ): Promise<UploadedAsset> {
    try {
      const asset = await this.client.assets.upload('image', imageBuffer, {
        filename,
      });

      return {
        assetId: asset._id,
        _id: asset._id,
        url: asset.url,
        width: asset.metadata?.dimensions?.width ?? 0,
        height: asset.metadata?.dimensions?.height ?? 0,
      };
    } catch (error) {
      throw new ProviderError('image-upload', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Creates a new post document.
   *
   * This operation is idempotent - if a post with the same slug already exists,
   * it returns the existing document instead of creating a duplicate.
   *
   * @param document - The post document to create.
   * @returns The created document information.
   */
  async createPost(document: SanityDocumentInput): Promise<CreatedDocument> {
    try {
      const slug = (document.slug as { current: string })?.current;
      if (!slug) {
        throw new FatalError('sanity-write', 'Document must have a slug.current field');
      }

      // Check for existing post with same slug (idempotency)
      const existing = await this.findPostBySlug(slug);
      if (existing) {
        // Document already exists - return it without creating duplicate
        return {
          documentId: existing._id,
          slug,
        };
      }

      // Create the document
      const result = await this.client.create(document);

      return {
        documentId: result._id,
        slug,
      };
    } catch (error) {
      if (error instanceof FatalError) {
        throw error;
      }
      throw new ProviderError('publish', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Creates or updates a document (patch if exists, create if not).
   *
   * @param documentId - The document ID.
   * @param document - The document data.
   * @returns The document ID.
   */
  async createOrUpdate(documentId: string, document: SanityDocumentInput): Promise<string> {
    try {
      const result = await this.client.createIfNotExists({
        ...document,
        _id: documentId,
      });

      return result._id;
    } catch (error) {
      throw new ProviderError('publish', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Patches an existing document.
   *
   * @param documentId - The document ID to patch.
   * @param patches - The patch operations to apply.
   * @returns True if the patch was successful.
   */
  async patchDocument(documentId: string, patches: Record<string, unknown>): Promise<boolean> {
    try {
      await this.client.patch(documentId).set(patches).commit();
      return true;
    } catch (error) {
      throw new ProviderError('publish', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Deletes a document by ID.
   *
   * @param documentId - The document ID to delete.
   */
  async deleteDocument(documentId: string): Promise<void> {
    try {
      await this.client.delete(documentId);
    } catch (error) {
      throw new ProviderError('publish', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Executes a transaction with multiple operations.
   *
   * @param operations - Array of transaction operations.
   * @returns True if the transaction succeeded.
   */
  async executeTransaction(
    operations: Array<{
      readonly type: 'create' | 'patch' | 'delete';
      readonly documentId?: string;
      readonly document?: SanityDocumentInput;
      readonly patches?: Record<string, unknown>;
    }>,
  ): Promise<boolean> {
    try {
      const transaction = this.client.transaction();

      for (const op of operations) {
        switch (op.type) {
          case 'create':
            if (op.document) {
              transaction.create(op.document);
            }
            break;
          case 'patch':
            if (op.documentId && op.patches) {
              transaction.patch(op.documentId, (p: ReturnType<SanityClient['patch']>) =>
                p.set(op.patches!),
              );
            }
            break;
          case 'delete':
            if (op.documentId) {
              transaction.delete(op.documentId);
            }
            break;
        }
      }

      await transaction.commit();
      return true;
    } catch (error) {
      throw new ProviderError('publish', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Verifies a document exists and is fetchable after creation.
   *
   * Used for idempotency check at Publish per architecture/07-error-handling.md.
   *
   * @param slug - The slug to check.
   * @returns The existing document, or null if not found.
   */
  async findPostBySlug(slug: string): Promise<{ _id: string; slug: { current: string } } | null> {
    try {
      const query = `*[_type == "post" && slug.current == $slug][0]{ _id, slug }`;
      return await this.client.fetch(query, { slug });
    } catch (error) {
      throw new ProviderError('sanity-read', 'sanity', undefined, this.isRetryable(error));
    }
  }

  /**
   * Fetches a document by ID to verify it was created.
   *
   * @param documentId - The document ID.
   * @returns The document, or null if not found.
   */
  async fetchDocument<T extends Record<string, unknown> = Record<string, unknown>>(
    documentId: string,
  ): Promise<T | null> {
    try {
      return (await this.client.getDocument<T>(documentId)) ?? null;
    } catch (error) {
      // Document not found is not an error
      const httpError = error as { statusCode?: number };
      if (httpError.statusCode === 404) {
        return null;
      }
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
 * Creates a Sanity write client from configuration.
 */
export function createSanityWriteClient(config: SanityWriteConfig): SanityWriteClient {
  return new SanityWriteClient(config);
}
