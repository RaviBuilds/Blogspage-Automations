/**
 * A scripted LLMProvider test double (10-testing-strategy.md). Used by
 * module unit tests to exercise moduleRunner/module logic without a real
 * provider call. Never used in production code.
 */
import type {
  LLMCallOptions,
  LLMCallResult,
  LLMProvider,
  ProviderCapabilities,
} from '@/providers/llm/LLMProvider.js';

/** Construction options for FakeLLMProvider. */
export interface FakeLLMProviderOptions {
  readonly text?: string;
  readonly usage?: Partial<LLMCallResult['usage']>;
  readonly costUsd?: number;
  readonly stopReason?: LLMCallResult['stopReason'];
  readonly capabilities?: ProviderCapabilities;
  readonly throws?: Error;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = Object.freeze({
  vision: false,
  jsonSchema: true,
  caching: false,
  reasoning: false,
});

/** A scripted, deterministic LLMProvider double for unit tests. */
export class FakeLLMProvider implements LLMProvider {
  public readonly capabilities: ProviderCapabilities;
  public readonly calls: LLMCallOptions[] = [];

  public constructor(private readonly options: FakeLLMProviderOptions = {}) {
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
  }

  public complete(options: LLMCallOptions): Promise<LLMCallResult> {
    this.calls.push(options);

    if (this.options.throws !== undefined) {
      return Promise.reject(this.options.throws);
    }

    return Promise.resolve({
      text: this.options.text ?? '',
      usage: {
        inputTokens: this.options.usage?.inputTokens ?? 0,
        outputTokens: this.options.usage?.outputTokens ?? 0,
        cachedInputTokens: this.options.usage?.cachedInputTokens ?? 0,
        reasoningTokens: this.options.usage?.reasoningTokens ?? 0,
      },
      costUsd: this.options.costUsd ?? 0,
      pricingVerifiedAt: '2026-01-01',
      providerName: 'fake',
      modelId: 'fake-model',
      stopReason: this.options.stopReason ?? 'complete',
    });
  }
}
