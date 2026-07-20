/**
 * Gemini adapter for the LLMProvider boundary (09-provider-abstraction.md).
 * Owns every Gemini-specific translation: request shape, thinking-budget
 * mapping, pricing, and error mapping. Nothing Gemini-specific is ever
 * visible outside this file.
 */
import { GoogleGenAI, ApiError as GenAiApiError } from '@google/genai';
import type { Content, Part } from '@google/genai';

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

const PROVIDER_NAME = 'gemini';

/** Updated whenever the pricing table below is re-checked against Gemini's real pricing page. */
const PRICING_VERIFIED_AT = '2026-07-19';

/** USD per token, derived from Gemini's published per-1M-token pricing. */
const PRICING_TABLE: Readonly<
  Record<string, { readonly input: number; readonly output: number; readonly cachedInput: number }>
> = Object.freeze({
  'gemini-2.5-flash': {
    input: 0.3 / 1_000_000,
    output: 2.5 / 1_000_000,
    cachedInput: 0.03 / 1_000_000,
  },
  'gemini-2.5-pro': {
    input: 1.25 / 1_000_000,
    output: 10 / 1_000_000,
    cachedInput: 0.125 / 1_000_000,
  },
  'gemini-2.5-flash-lite': {
    input: 0.1 / 1_000_000,
    output: 0.4 / 1_000_000,
    cachedInput: 0.01 / 1_000_000,
  },
});

const DEFAULT_PRICING = {
  input: 1.25 / 1_000_000,
  output: 10 / 1_000_000,
  cachedInput: 0.125 / 1_000_000,
};

function resolvePricing(modelId: string): { input: number; output: number; cachedInput: number } {
  return PRICING_TABLE[modelId] ?? DEFAULT_PRICING;
}

function toStopReason(finishReason: string | undefined): LLMCallResult['stopReason'] {
  switch (finishReason) {
    case 'STOP':
      return 'complete';
    case 'MAX_TOKENS':
      return 'maxTokens';
    case 'SAFETY':
    case 'RECITATION':
      return 'refusal';
    default:
      return 'error';
  }
}

function buildUserContent(userPrompt: string, images: LLMCallOptions['images']): Content {
  const parts: Part[] = [{ text: userPrompt }];

  for (const image of images ?? []) {
    parts.push({ inlineData: { data: image.data, mimeType: image.mimeType } });
  }

  return { role: 'user', parts };
}

function toThinkingBudget(reasoningEffort: LLMCallOptions['reasoningEffort']): number | undefined {
  if (reasoningEffort === undefined || reasoningEffort === 'none') {
    return undefined;
  }

  const budgetByEffort: Record<'low' | 'medium' | 'high', number> = {
    low: 2_048,
    medium: 8_192,
    high: 24_576,
  };

  return budgetByEffort[reasoningEffort];
}

/** Gemini's real API adapter. Every Gemini SDK type stays inside this file. */
export class GeminiProvider implements LLMProvider, ProviderHealthReporter {
  public readonly capabilities: ProviderCapabilities = Object.freeze({
    vision: true,
    jsonSchema: true,
    caching: true,
    reasoning: true,
  });

  private readonly client: GoogleGenAI;
  private readonly health = new ProviderHealthTracker(PROVIDER_NAME);

  public constructor(
    private readonly modelId: string,
    apiKey: string,
    private readonly defaultTimeoutMs: number,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  public async complete(options: LLMCallOptions): Promise<LLMCallResult> {
    const startedAt = Date.now();

    try {
      const thinkingBudget = toThinkingBudget(options.reasoningEffort);

      const response = await this.client.models.generateContent({
        model: this.modelId,
        contents: [buildUserContent(options.userPrompt, options.images)],
        config: {
          systemInstruction: options.systemPrompt,
          maxOutputTokens: options.maxOutputTokens,
          httpOptions: { timeout: options.timeoutMs ?? this.defaultTimeoutMs },
          ...(options.responseFormat === 'json'
            ? {
                responseMimeType: 'application/json',
                ...(options.jsonSchema === undefined ? {} : { responseSchema: options.jsonSchema }),
              }
            : {}),
          ...(thinkingBudget === undefined
            ? {}
            : { thinkingConfig: { includeThoughts: false, thinkingBudget } }),
        },
      });

      const latencyMs = Date.now() - startedAt;
      this.health.recordSuccess(latencyMs);

      const text = response.text ?? '';
      const pricing = resolvePricing(this.modelId);
      const usage = response.usageMetadata;
      const inputTokens = usage?.promptTokenCount ?? 0;
      const outputTokens = usage?.candidatesTokenCount ?? 0;
      const cachedInputTokens = usage?.cachedContentTokenCount ?? 0;
      const reasoningTokens = usage?.thoughtsTokenCount ?? 0;
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
        stopReason: toStopReason(response.candidates?.[0]?.finishReason),
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
  if (error instanceof GenAiApiError) {
    return new ProviderError(
      moduleKey,
      PROVIDER_NAME,
      error.status,
      isRetryableStatus(error.status),
    );
  }

  return new ProviderError(moduleKey, PROVIDER_NAME, undefined, true);
}
