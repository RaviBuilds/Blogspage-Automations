/**
 * Anthropic adapter for the LLMProvider boundary (09-provider-abstraction.md).
 * Owns every Anthropic-specific translation: request shape, cache-control
 * markers, extended-thinking configuration, pricing, and error mapping.
 * Nothing Anthropic-specific is ever visible outside this file.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages';

import { ProviderError } from '@/core/errors.js';
import { isRetryableStatus } from '@/providers/shared/classifyHttpStatus.js';
import { ProviderHealthTracker } from '@/providers/shared/ProviderStatus.js';
import type { ProviderHealthReporter, ProviderStatus } from '@/providers/shared/ProviderStatus.js';
import type {
  LLMCallOptions,
  LLMCallResult,
  LLMProvider,
  ProviderCapabilities,
} from '@/providers/llm/LLMProvider.js';

const PROVIDER_NAME = 'anthropic';

/** Updated whenever the pricing table below is re-checked against Anthropic's real pricing page. */
const PRICING_VERIFIED_AT = '2026-07-19';

/** USD per token, derived from Anthropic's published per-1M-token pricing. */
const PRICING_TABLE: Readonly<
  Record<string, { readonly input: number; readonly output: number; readonly cachedInput: number }>
> = Object.freeze({
  'claude-haiku-4-5': { input: 1 / 1_000_000, output: 5 / 1_000_000, cachedInput: 0.1 / 1_000_000 },
  'claude-sonnet-5': { input: 3 / 1_000_000, output: 15 / 1_000_000, cachedInput: 0.3 / 1_000_000 },
  'claude-opus-4-8': { input: 5 / 1_000_000, output: 25 / 1_000_000, cachedInput: 0.5 / 1_000_000 },
});

const DEFAULT_PRICING = {
  input: 3 / 1_000_000,
  output: 15 / 1_000_000,
  cachedInput: 0.3 / 1_000_000,
};

function resolvePricing(modelId: string): { input: number; output: number; cachedInput: number } {
  return PRICING_TABLE[modelId] ?? DEFAULT_PRICING;
}

function toStopReason(stopReason: string | null): LLMCallResult['stopReason'] {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'tool_use':
    case 'pause_turn':
      return 'complete';
    case 'max_tokens':
      return 'maxTokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'error';
  }
}

function buildUserContent(
  userPrompt: string,
  images: LLMCallOptions['images'],
): MessageParam['content'] {
  if (images === undefined || images.length === 0) {
    return userPrompt;
  }

  return [
    { type: 'text', text: userPrompt },
    ...images.map((image) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: image.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        data: image.data,
      },
    })),
  ];
}

function buildSystemParam(
  systemPrompt: string,
  cacheableSystemPromptPrefix: boolean | undefined,
): string | TextBlockParam[] {
  if (cacheableSystemPromptPrefix !== true) {
    return systemPrompt;
  }

  return [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

function toThinkingConfig(
  reasoningEffort: LLMCallOptions['reasoningEffort'],
): { type: 'enabled'; budget_tokens: number } | undefined {
  if (reasoningEffort === undefined || reasoningEffort === 'none') {
    return undefined;
  }

  const budgetByEffort: Record<'low' | 'medium' | 'high', number> = {
    low: 2_048,
    medium: 8_192,
    high: 24_576,
  };

  return { type: 'enabled', budget_tokens: budgetByEffort[reasoningEffort] };
}

/** Anthropic's real API adapter. Every Anthropic SDK type stays inside this file. */
export class AnthropicProvider implements LLMProvider, ProviderHealthReporter {
  public readonly capabilities: ProviderCapabilities = Object.freeze({
    vision: true,
    jsonSchema: true,
    caching: true,
    reasoning: true,
  });

  private readonly client: Anthropic;
  private readonly health = new ProviderHealthTracker(PROVIDER_NAME);

  public constructor(
    private readonly modelId: string,
    apiKey: string,
    private readonly defaultTimeoutMs: number,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  public async complete(options: LLMCallOptions): Promise<LLMCallResult> {
    const startedAt = Date.now();

    try {
      const message = await this.client.messages.create(
        {
          model: this.modelId,
          max_tokens: options.maxOutputTokens,
          system: buildSystemParam(options.systemPrompt, options.cacheableSystemPromptPrefix),
          messages: [
            { role: 'user', content: buildUserContent(options.userPrompt, options.images) },
          ],
          ...(options.responseFormat === 'json' && options.jsonSchema !== undefined
            ? {
                output_config: {
                  format: {
                    type: 'json_schema' as const,
                    schema: options.jsonSchema as Record<string, unknown>,
                  },
                },
              }
            : {}),
          ...(this.capabilities.reasoning
            ? (() => {
                const thinking = toThinkingConfig(options.reasoningEffort);
                return thinking === undefined ? {} : { thinking };
              })()
            : {}),
        },
        { timeout: options.timeoutMs ?? this.defaultTimeoutMs },
      );

      const latencyMs = Date.now() - startedAt;
      this.health.recordSuccess(latencyMs);

      const textBlocks = message.content.filter((block) => block.type === 'text');
      const text = textBlocks.map((block) => block.text).join('');
      const pricing = resolvePricing(this.modelId);
      const inputTokens = message.usage.input_tokens ?? 0;
      const outputTokens = message.usage.output_tokens;
      const cachedInputTokens = message.usage.cache_read_input_tokens ?? 0;
      const reasoningTokens = message.usage.output_tokens_details?.thinking_tokens ?? 0;
      const costUsd =
        inputTokens * pricing.input +
        outputTokens * pricing.output +
        cachedInputTokens * pricing.cachedInput;

      return {
        text,
        usage: { inputTokens, outputTokens, cachedInputTokens, reasoningTokens },
        costUsd,
        pricingVerifiedAt: PRICING_VERIFIED_AT,
        providerName: PROVIDER_NAME,
        modelId: this.modelId,
        stopReason: toStopReason(message.stop_reason),
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      this.health.recordFailure(latencyMs);
      throw toProviderError(error, options.moduleKey);
    }
  }

  public getStatus(): ProviderStatus {
    return this.health.getStatus();
  }
}

function toProviderError(error: unknown, moduleKey: string): ProviderError {
  if (
    error instanceof Anthropic.APIUserAbortError ||
    error instanceof Anthropic.APIConnectionTimeoutError
  ) {
    return new ProviderError(moduleKey, PROVIDER_NAME, undefined, true);
  }

  if (error instanceof Anthropic.APIError) {
    const status: number | undefined = typeof error.status === 'number' ? error.status : undefined;
    return new ProviderError(moduleKey, PROVIDER_NAME, status, isRetryableStatus(status));
  }

  return new ProviderError(moduleKey, PROVIDER_NAME, undefined, true);
}
