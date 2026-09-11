import { describe, expect, it } from 'vitest';

import { FatalError } from '@/core/errors.js';
import { loadConfig } from '@/config/env.js';
import {
  applyClientProfile,
  DEFAULT_CLIENT_PROFILE,
  DEFAULT_PROFILE_ID,
  moduleTier,
  resolveClientProfile,
  type ClientProfile,
} from '@/config/profiles.js';

const VALID_ENVIRONMENT = {
  ANTHROPIC_API_KEY: 'anthropic-secret',
  OPENAI_API_KEY: 'openai-secret',
  SANITY_DATASET: 'sandbox',
  SANITY_PROJECT_ID: 'project-id',
  SANITY_WRITE_TOKEN: 'sanity-secret',
};

describe('client profiles', () => {
  it('resolves the built-in owner profile with budget defaults', () => {
    const profile = resolveClientProfile('blogspage');

    expect(profile.id).toBe('blogspage');
    expect(profile.imageSource).toBe('manual');
    expect(profile.runSet).toBe('budget');
    expect(profile.approvals).toEqual({ outline: false, article: true });
    expect(profile.costGuardrail.maxCostUsd).toBe(0.1);
    expect(Object.isFrozen(profile.approvals)).toBe(true);
  });

  it('uses the owner profile id as the default when none is requested', () => {
    expect(DEFAULT_PROFILE_ID).toBe(DEFAULT_CLIENT_PROFILE.id);
    expect(DEFAULT_PROFILE_ID).toBe('blogspage');
  });

  it('throws a FatalError for an unknown profile id', () => {
    expect(() => resolveClientProfile('unknown-client')).toThrow(FatalError);
  });

  it('applies per-module tier overrides with fallback to the given tier', () => {
    const custom: Readonly<ClientProfile> = {
      id: 'custom',
      displayName: 'Custom Client',
      targetSite: 'blogspage',
      locale: 'en',
      imageSource: 'ai',
      runSet: 'full',
      approvals: { outline: true, article: true },
      costGuardrail: { maxCostUsd: 1.0 },
      llmTierOverrides: { writer: 'PREMIUM' },
    };

    expect(moduleTier(custom, 'writer', 'STANDARD')).toBe('PREMIUM');
    expect(moduleTier(custom, 'research', 'STANDARD')).toBe('STANDARD');
  });

  it('overlays a profile onto a loaded Config without mutating it', () => {
    const config = loadConfig(VALID_ENVIRONMENT);
    const profile = resolveClientProfile(DEFAULT_PROFILE_ID);
    const configWithProfile = applyClientProfile(config, profile);

    expect(configWithProfile.profileId).toBe('blogspage');
    expect(configWithProfile.imageSource).toBe('manual');
    expect(configWithProfile.runSet).toBe('budget');
    expect(configWithProfile.approvals?.outline).toBe(false);
    expect(configWithProfile.approvals?.article).toBe(true);
    expect(configWithProfile.costGuardrail?.maxCostUsd).toBe(0.1);
    expect(Object.isFrozen(configWithProfile)).toBe(true);
    expect(Object.isFrozen(configWithProfile.approvals)).toBe(true);
    expect(Object.isFrozen(configWithProfile.costGuardrail)).toBe(true);

    // Env-driven fields and shared model map are preserved untouched.
    expect(configWithProfile.sanityProjectId).toBe('project-id');
    expect(configWithProfile.sanityWriteToken).toBe('sanity-secret');
    expect(configWithProfile.models).toBe(config.models);

    // The input Config is never mutated.
    expect(config.profileId).toBeUndefined();
    expect(config.imageSource).toBeUndefined();
  });
});