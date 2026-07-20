/**
 * The provider-agnostic LLM boundary (09-provider-abstraction.md). No module
 * under src/modules/ may import an LLM SDK directly — every module depends
 * only on this interface. This file declares the interface only; it makes no
 * network call and has zero dependency on any concrete adapter.
 */

/** An image attachment for a vision-capable call. */
export interface LLMCallImage {
  readonly data: string;
  readonly mimeType: string;
}

/** Options for one LLMProvider.complete() call. */
export interface LLMCallOptions {
  readonly moduleKey: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly responseFormat: 'text' | 'json';
  readonly jsonSchema?: object;
  readonly maxOutputTokens: number;
  readonly images?: readonly LLMCallImage[];
  readonly cacheableSystemPromptPrefix?: boolean;
  readonly timeoutMs?: number;
  readonly reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
}

/** Token usage for one completed (or failed-after-partial-usage) call. */
export interface LLMUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
}

/** The result of one successful LLMProvider.complete() call. */
export interface LLMCallResult {
  readonly text: string;
  readonly usage: LLMUsage;
  readonly costUsd: number;
  readonly pricingVerifiedAt: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly stopReason: 'complete' | 'maxTokens' | 'refusal' | 'error';
}

/** Capability flags an adapter must report honestly (09-provider-abstraction.md). */
export interface ProviderCapabilities {
  readonly vision: boolean;
  readonly jsonSchema: boolean;
  readonly caching: boolean;
  readonly reasoning: boolean;
}

/** The provider-agnostic LLM boundary every module and moduleRunner depends on. */
export interface LLMProvider {
  complete(options: LLMCallOptions): Promise<LLMCallResult>;
  readonly capabilities: ProviderCapabilities;
}

/** The most conservative capability set — used as a fail-closed fallback for unknown models. */
export const FALLBACK_CAPABILITIES: ProviderCapabilities = Object.freeze({
  vision: false,
  jsonSchema: false,
  caching: false,
  reasoning: false,
});
