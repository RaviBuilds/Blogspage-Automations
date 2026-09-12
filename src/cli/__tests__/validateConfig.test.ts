/**
 * Tests for validateConfig CLI
 */

import { describe, expect, it } from 'vitest';

import {
  validateEnvironment,
  validateConfig,
  validateModules,
  type ValidateArgs,
} from '@/cli/validateConfig.js';

describe('validateConfig CLI', () => {
  describe('validateEnvironment', () => {
    it('should detect missing required variables', () => {
      // Clear environment
      const originalEnv = { ...process.env };
      for (const key of Object.keys(process.env)) {
        delete process.env[key];
      }

      const result = validateEnvironment();

      expect(result.valid).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
      expect(result.missing).toContain('SANITY_PROJECT_ID');
      expect(result.missing).toContain('ANTHROPIC_API_KEY');

      // Restore environment
      process.env = originalEnv;
    });

    it('should validate when all required variables are present', () => {
      // Set required variables
      const originalEnv = { ...process.env };
      process.env.SANITY_PROJECT_ID = 'test-project';
      process.env.SANITY_DATASET = 'test-dataset';
      process.env.SANITY_WRITE_TOKEN = 'test-token';
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
      process.env.OPENAI_API_KEY = 'test-openai-key';

      const result = validateEnvironment();

      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);

      // Restore environment
      process.env = originalEnv;
    });
  });

  describe('validateConfig', () => {
    it('should validate model configuration', () => {
      const result = validateConfig();

      expect(result.valid).toBe(true);
      expect(result.models.length).toBe(3);

      const tierNames = result.models.map((m) => m.tier);
      expect(tierNames).toContain('CHEAP');
      expect(tierNames).toContain('STANDARD');
      expect(tierNames).toContain('PREMIUM');
    });

    it('should validate image model configuration', () => {
      const result = validateConfig();

      expect(result.imageModel.tier).toBe('IMAGE');
      expect(result.imageModel.provider).toBeDefined();
      expect(result.imageModel.modelId).toBeDefined();
    });
  });

  describe('validateModules', () => {
    it('should validate all modules', () => {
      const result = validateModules();

      expect(result.count).toBe(8);

      const keys = result.modules.map((m) => m.key);
      expect(keys).toContain('research');
      expect(keys).toContain('planner');
      expect(keys).toContain('seo-planner');
      expect(keys).toContain('writer');
      expect(keys).toContain('reviewer-technical');
      expect(keys).toContain('humanizer');
      expect(keys).toContain('content-assets-planner');
      expect(keys).toContain('publish');
    });

    it('should detect correct module dependencies', () => {
      const result = validateModules();

      // Find planner module
      const plannerModule = result.modules.find((m) => m.key === 'planner');
      expect(plannerModule).toBeDefined();
      expect(plannerModule!.dependencies).toContain('research');
    });
  });

  describe('ValidateArgs type', () => {
    it('should have correct structure', () => {
      const args: ValidateArgs = {
        verbose: false,
        checkPrompts: false,
        json: false,
      };

      expect(args.verbose).toBe(false);
      expect(args.checkPrompts).toBe(false);
      expect(args.json).toBe(false);
    });

    it('should accept verbose mode', () => {
      const args: ValidateArgs = {
        verbose: true,
        checkPrompts: true,
        json: false,
      };

      expect(args.verbose).toBe(true);
      expect(args.checkPrompts).toBe(true);
    });
  });
});
