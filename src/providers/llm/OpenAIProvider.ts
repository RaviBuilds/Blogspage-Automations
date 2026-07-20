/**
 * OpenAI adapter for the LLMProvider boundary (09-provider-abstraction.md).
 * Owns every OpenAI-specific translation: request shape, structured-output
 * schema, reasoning-effort mapping, pricing, and error mapping. Nothing
 * OpenAI-specific is ever visible outside this file.
 */
import OpenAI from 'openai';
import type {
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';

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

const PROVIDER_NAME = 'openai';

/** Updated whenever the pricing table below is re-checked against OpenAI's real pricing page. */
const PRICING_VERIFIED_AT = '2026-07-19';

/** USD per token, derived from OpenAI's published per-1M-token pricing. */
const PRICING_TABLE: Readonly<
  Record<string, { readonly input: number; readonly output: number; readonly cachedInput: number }>
> = Object.freeze({
  'gpt-5.6-luna': { input: 1 / 1_000_000, output: 6 / 1_000_000, cachedInput: 0.1 / 1_000_000 },
  'gpt-5.6-terra': {
    input: 2.5 / 1_000_000,
    output: 15 / 1_000_000,
    cachedInput: 0.25 / 1_000_000,
  },
  'gpt-5.6-sol': { input: 5 / 1_000_000, output: 30 / 1_000_000, cachedInput: 0.5 / 1_000_000 },
});

const DEFAULT_PRICING = {
  input: 2.5 / 1_000_000,
  output: 15 / 1_000_000,
  cachedInput: 0.25 / 1_000_000,
};

function resolvePricing(modelId: string): { input: number; output: number; cachedInput: number } {
  return PRICING_TABLE[modelId] ?? DEFAULT_PRICING;
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

function buildResponseFormat(
  options: LLMCallOptions,
): ChatCompletionCreateParamsNonStreaming['response_format'] | undefined {
  if (options.responseFormat !== 'json') {
    return undefined;
  }

  if (options.jsonSchema !== undefined) {
    return {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        schema: options.jsonSchema as Record<string, unknown>,
      },
    };
  }

  return { type: 'json_object' };
}

function toReasoningEffort(
  reasoningEffort: LLMCallOptions['reasoningEffort'],
): 'low' | 'medium' | 'high' | undefined {
  if (reasoningEffort === undefined || reasoningEffort === 'none') {
    return undefined;
  }

  return reasoningEffort;
}

/** OpenAI's real API adapter. Every OpenAI SDK type stays inside this file. */
export class OpenAIProvider implements LLMProvider, ProviderHealthReporter {
  public readonly capabilities: ProviderCapabilities = Object.freeze({
    vision: true,
    jsonSchema: true,
    caching: true,
    reasoning: true,
  });

  private readonly client: OpenAI;
  private readonly health = new ProviderHealthTracker(PROVIDER_NAME);

  public constructor(
    private readonly modelId: string,
    apiKey: string,
    private readonly defaultTimeoutMs: number,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  public async complete(options: LLMCallOptions): Promise<LLMCallResult> {
    const startedAt = Date.now();

    try {
      const reasoningEffort = toReasoningEffort(options.reasoningEffort);

      const responseFormat = buildResponseFormat(options);

      const completion = await this.client.chat.completions.create(
        {
          model: this.modelId,
          max_completion_tokens: options.maxOutputTokens,
          messages: [
            { role: 'system', content: options.systemPrompt },
            { role: 'user', content: buildUserContent(options.userPrompt, options.images) },
          ],
          ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
          ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
        },
        { timeout: options.timeoutMs ?? this.defaultTimeoutMs },
      );

      const latencyMs = Date.now() - startedAt;
      this.health.recordSuccess(latencyMs);

      const choice = completion.choices[0];
      const text = choice?.message.content ?? '';
      const pricing = resolvePricing(this.modelId);
      const inputTokens = completion.usage?.prompt_tokens ?? 0;
      const outputTokens = completion.usage?.completion_tokens ?? 0;
      const cachedInputTokens = completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const reasoningTokens = completion.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
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
