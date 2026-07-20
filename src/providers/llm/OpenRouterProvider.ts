/**
 * OpenRouter adapter for the LLMProvider boundary (09-provider-abstraction.md).
 * OpenRouter exposes an OpenAI-compatible API, so this adapter reuses the
 * OpenAI SDK pointed at OpenRouter's base URL — but capabilities are resolved
 * per configured `modelId` from a lookup table, never a fixed class constant,
 * because OpenRouter's real vision/JSON-schema/caching/reasoning support
 * depends entirely on which underlying model it routes to. An unrecognized
 * modelId falls back to the most conservative capability set (fail closed).
 */
import OpenAI from 'openai';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';

import { ProviderError } from '@/core/errors.js';
import { isRetryableStatus } from '@/providers/shared/classifyHttpStatus.js';
import { ProviderHealthTracker } from '@/providers/shared/ProviderStatus.js';
import type { ProviderHealthReporter, ProviderStatus } from '@/providers/shared/ProviderStatus.js';
import { FALLBACK_CAPABILITIES } from '@/providers/llm/LLMProvider.js';
import type {
  LLMCallOptions,
  LLMCallResult,
  LLMProvider,
  ProviderCapabilities,
} from '@/providers/llm/LLMProvider.js';

const PROVIDER_NAME = 'openrouter';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Per-model capability lookup. OpenRouter routes to many underlying models
 * with genuinely different capabilities — extend this table as new routed
 * models are actually used by this project (09-provider-abstraction.md).
 */
const MODEL_CAPABILITIES: Readonly<Record<string, ProviderCapabilities>> = Object.freeze({
  'anthropic/claude-sonnet-5': Object.freeze({
    vision: true,
    jsonSchema: true,
    caching: true,
    reasoning: false,
  }),
  'openai/gpt-5.6-terra': Object.freeze({
    vision: true,
    jsonSchema: true,
    caching: true,
    reasoning: true,
  }),
});

function resolveCapabilities(modelId: string): ProviderCapabilities {
  return MODEL_CAPABILITIES[modelId] ?? FALLBACK_CAPABILITIES;
}

function toStopReason(finishReason: string | null | undefined): LLMCallResult['stopReason'] {
  switch (finishReason) {
    case 'stop':
    case 'tool_calls':
    case 'function_call':
      return 'complete';
    case 'length':
      return 'maxTokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'error';
  }
}

function buildUserContent(
  userPrompt: string,
  images: LLMCallOptions['images'],
): string | ChatCompletionContentPart[] {
  if (images === undefined || images.length === 0) {
    return userPrompt;
  }

  const imageParts: ChatCompletionContentPart[] = images.map((image) => ({
    type: 'image_url',
    image_url: { url: `data:${image.mimeType};base64,${image.data}` },
  }));

  return [{ type: 'text', text: userPrompt }, ...imageParts];
}

/** OpenRouter's real API adapter (OpenAI-compatible transport). */
export class OpenRouterProvider implements LLMProvider, ProviderHealthReporter {
  public readonly capabilities: ProviderCapabilities;

  private readonly client: OpenAI;
  private readonly health = new ProviderHealthTracker(PROVIDER_NAME);

  public constructor(
    private readonly modelId: string,
    apiKey: string,
    private readonly defaultTimeoutMs: number,
  ) {
    this.capabilities = resolveCapabilities(modelId);
    this.client = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });
  }

  public async complete(options: LLMCallOptions): Promise<LLMCallResult> {
    const startedAt = Date.now();

    try {
      const completion = await this.client.chat.completions.create(
        {
          model: this.modelId,
          max_completion_tokens: options.maxOutputTokens,
          messages: [
            { role: 'system', content: options.systemPrompt },
            { role: 'user', content: buildUserContent(options.userPrompt, options.images) },
          ],
          ...(options.responseFormat === 'json'
            ? { response_format: { type: 'json_object' } }
            : {}),
        },
        { timeout: options.timeoutMs ?? this.defaultTimeoutMs },
      );

      const latencyMs = Date.now() - startedAt;
      this.health.recordSuccess(latencyMs);

      const choice = completion.choices[0];
      const text = choice?.message.content ?? '';
      const usage = completion.usage as (OpenAI.CompletionUsage & { cost?: number }) | undefined;
      const inputTokens = usage?.prompt_tokens ?? 0;
      const outputTokens = usage?.completion_tokens ?? 0;
      const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      const costUsd = usage?.cost ?? 0;

      return {
        text,
        usage: { inputTokens, outputTokens, cachedInputTokens, reasoningTokens },
        costUsd,
        pricingVerifiedAt: new Date().toISOString(),
        providerName: PROVIDER_NAME,
        modelId: this.modelId,
        stopReason: toStopReason(choice?.finish_reason),
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
    error instanceof OpenAI.APIUserAbortError ||
    error instanceof OpenAI.APIConnectionTimeoutError
  ) {
    return new ProviderError(moduleKey, PROVIDER_NAME, undefined, true);
  }

  if (error instanceof OpenAI.APIError) {
    const status: number | undefined = typeof error.status === 'number' ? error.status : undefined;
    return new ProviderError(moduleKey, PROVIDER_NAME, status, isRetryableStatus(status));
  }

  return new ProviderError(moduleKey, PROVIDER_NAME, undefined, true);
}
