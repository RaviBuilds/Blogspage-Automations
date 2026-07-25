/**
 * Shared vocabulary for the pipeline's foundational infrastructure.
 *
 * The complete PipelineState contract is intentionally introduced in Phase 6.
 */

/** The stable identifier used across modules, prompts, costs, and logs. */
export type ModuleKey =
  | 'sheet-reader'
  | 'research'
  | 'planner'
  | 'seo-planner'
  | 'writer'
  | 'reviewer-technical'
  | 'reviewer-seo'
  | 'humanizer'
  | 'content-assets-planner'
  | 'qa'
  | 'improver'
  | 'image-planner'
  | 'image-generator'
  | 'image-validator'
  | 'portable-text'
  | 'internal-links'
  | 'faq-generator'
  | 'structured-data-check'
  | 'image-upload'
  | 'sanity-builder'
  | 'publish'
  | 'notify';

/** Provider identifiers supported by the future provider-adapter boundary. */
export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'local';

/** The content-quality tier assigned to an LLM call. */
export type ModelTier = 'CHEAP' | 'STANDARD' | 'PREMIUM';

/** A concrete provider and model selected for one quality tier. */
export interface ModelSpec {
  readonly provider: ProviderName;
  readonly modelId: string;
}

/** Immutable mapping from every content-quality tier to a concrete model. */
export type ModelsConfig = Readonly<Record<ModelTier, ModelSpec>>;

/** Default backoff controls used by the future centralized module runner. */
export interface BackoffConfig {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

/** Per-provider-class default request timeouts (08-retry-strategy.md's DEFAULT_TIMEOUT). */
export interface TimeoutConfig {
  readonly anthropicTimeoutMs: number;
  readonly openAiTimeoutMs: number;
  readonly geminiTimeoutMs: number;
  readonly openRouterTimeoutMs: number;
  readonly localProviderTimeoutMs: number;
}

/** Immutable pipeline controls shared by future orchestration code. */
export interface PipelineConfig {
  readonly backoff: BackoffConfig;
  readonly maxImageRetries: number;
  readonly maxReviewIterations: number;
  readonly maxConcurrentImageGenerations: number;
  readonly timeouts: TimeoutConfig;
}

/** A concrete image-generation provider and model selected for image tiers. */
export interface ImageModelSpec {
  readonly provider: 'openai' | 'gemini';
  readonly modelId: string;
}

/**
 * Process-level configuration. It is loaded once at startup and never belongs
 * to PipelineState.
 */
export interface Config {
  readonly anthropicApiKey: string;
  readonly openAiApiKey: string | undefined;
  readonly geminiApiKey: string | undefined;
  readonly openRouterApiKey: string | undefined;
  readonly localEndpointUrl: string | undefined;
  readonly models: ModelsConfig;
  readonly imageModel: ImageModelSpec;
  readonly pipeline: PipelineConfig;
  readonly sanityDataset: string;
  readonly sanityProjectId: string;
  readonly sanityWriteToken: string;
}

/** The four error classes recognized by the pipeline retry and routing policy. */
export type PipelineErrorClass =
  | 'ValidationError'
  | 'ProviderError'
  | 'RetryableError'
  | 'FatalError';
