/**
 * Local LLM adapter for the LLMProvider boundary (09-provider-abstraction.md).
 * Targets an OpenAI-compatible local inference server via a configured
 * endpoint URL, so this adapter reuses the OpenAI SDK pointed at that URL.
 * Capabilities are resolved per configured `modelId` from a lookup table,
 * never a fixed class constant, since a self-hosted model's real
 * capabilities depend entirely on whatever model is actually deployed behind
 * that endpoint. An unrecognized modelId falls back to the most conservative
 * capability set (fail closed) — caching/reasoning: false is expected and
 * normal here, not a gap to apologize for.
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

const PROVIDER_NAME = 'local';

/**
 * Per-model capability lookup, keyed by whatever local model identifier the
 * deployment reports or is configured with. Extend as new local models are
 * actually used by this project (09-provider-abstraction.md).
 */
const MODEL_CAPABILITIES: Readonly<Record<string, ProviderCapabilities>> = Object.freeze({
  'llama-3.1-70b-instruct': Object.freeze({
    vision: false,
    jsonSchema: true,
    caching: false,
    reasoning: false,
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

/** Local, self-hosted OpenAI-compatible adapter. */
export class LocalLLMProvider implements LLMProvider, ProviderHealthReporter {
  public readonly capabilities: ProviderCapabilities;

  private readonly client: OpenAI;
  private readonly health = new ProviderHealthTracker(PROVIDER_NAME);

  public constructor(
    private readonly modelId: string,
    endpointUrl: string,
    private readonly defaultTimeoutMs: number,
  ) {
    this.capabilities = resolveCapabilities(modelId);
    this.client = new OpenAI({ apiKey: 'local', baseURL: endpointUrl });
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
      const inputTokens = completion.usage?.prompt_tokens ?? 0;
      const outputTokens = completion.usage?.completion_tokens ?? 0;
      const cachedInputTokens = completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const reasoningTokens = completion.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

      return {
        text,
        usage: { inputTokens, outputTokens, cachedInputTokens, reasoningTokens },
        costUsd: 0,
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
