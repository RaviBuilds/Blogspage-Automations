/**
 * Client Profiles — the per-customer configuration binding layer.
 *
 * Every difference between two customers of this software is a value here,
 * never module code (`20-product-reselling-architecture.md`). A profile
 * selects the run-set, image source, approval checkpoints, cost guardrails,
 * and (optionally) per-module tier overrides for a single run.
 *
 * Env vars carry secrets; profiles carry decisions. `loadConfig` +
 * `applyClientProfile` together produce the process `Config`.
 *
 * @see architecture/20-product-reselling-architecture.md - Client Profile spec
 * @see architecture/21-cost-budget-modes-human-in-loop.md - run-sets and budgets
 */

import { FatalError } from '@/core/errors.js';
import type {
  ApprovalsConfig,
  Config,
  CostGuardrail,
  ImageSource,
  ModuleKey,
  ModelTier,
  RunSet,
} from '@/core/types.js';

/** The default per-client approval flags (21-cost-budget-modes-human-in-loop.md). */
export const DEFAULT_APPROVALS: ApprovalsConfig = Object.freeze({
  /** Outline approval is off by default (BUDGET mode). */
  outline: false,
  /** The owner personally reviews every article before publish. */
  article: true,
});

/** The owner's default per-run cost guardrail (hard cap ≈ $0.10/article). */
export const DEFAULT_COST_GUARDRAIL: CostGuardrail = Object.freeze({
  maxCostUsd: 0.1,
});

/** An immutable per-client configuration object. */
export interface ClientProfile {
  /** Stable profile id; also the run's `metadata.clientProfileId`. */
  readonly id: string;
  /** Human-readable name for logs and reports. */
  readonly displayName: string;
  /** The target website for publishing (matches `metadata.targetSite`). */
  readonly targetSite: string;
  /** Prompt locale axis (`metadata.locale`, defaults 'en'). */
  readonly locale: string;
  /** How a run's images are sourced (20/21). */
  readonly imageSource: ImageSource;
  /** Which module subset + checkpoints the run uses (21). */
  readonly runSet: RunSet;
  /** Human-in-the-loop approval checkpoints (21). */
  readonly approvals: Readonly<ApprovalsConfig>;
  /** Hard per-run cost guardrail (21). */
  readonly costGuardrail: Readonly<CostGuardrail>;
  /** Optional per-module tier overrides; missing keys fall back to models.ts. */
  readonly llmTierOverrides: Readonly<Partial<Record<ModuleKey, ModelTier>>>;
}

/** The owner's own profile — BUDGET run-set, manual images, human article approval. */
export const DEFAULT_CLIENT_PROFILE: Readonly<ClientProfile> = Object.freeze({
  id: 'blogspage',
  displayName: 'Blogspage Agency',
  targetSite: 'blogspage',
  locale: 'en',
  imageSource: 'manual',
  runSet: 'budget',
  approvals: DEFAULT_APPROVALS,
  costGuardrail: DEFAULT_COST_GUARDRAIL,
  llmTierOverrides: Object.freeze({}),
});

const BUILTIN_PROFILES: ReadonlyMap<string, Readonly<ClientProfile>> = new Map([
  [DEFAULT_CLIENT_PROFILE.id, DEFAULT_CLIENT_PROFILE],
]);

/** The profile id used when none is requested. */
export const DEFAULT_PROFILE_ID: string = DEFAULT_CLIENT_PROFILE.id;

/** Resolves a profile id to an immutable ClientProfile. */
export function resolveClientProfile(id: string): Readonly<ClientProfile> {
  const profile = BUILTIN_PROFILES.get(id);
  if (profile === undefined) {
    throw new FatalError('config', `Unknown client profile: "${id}".`);
  }
  return profile;
}

/** Returns `fallback` for a module, overridden by the profile's tier map when present. */
export function moduleTier(
  profile: Readonly<ClientProfile>,
  module: ModuleKey,
  fallback: ModelTier,
): ModelTier {
  return profile.llmTierOverrides[module] ?? fallback;
}

/**
 * Overlays a Client Profile onto a loaded Config.
 *
 * Secret-bearing and CMS-target fields remain env-driven (`config/env.ts`);
 * the profile fields that shape run behavior — profile id, image source,
 * run-set, approval checkpoints, cost guardrail — are overlaid here. Returns
 * a new frozen Config; never mutates the input.
 */
export function applyClientProfile(config: Config, profile: Readonly<ClientProfile>): Config {
  return Object.freeze({
    ...config,
    profileId: profile.id,
    imageSource: profile.imageSource,
    runSet: profile.runSet,
    approvals: Object.freeze({ ...profile.approvals }),
    costGuardrail: Object.freeze({ ...profile.costGuardrail }),
  });
}
