/**
 * Tests for seedRefs - reference data and category inference.
 */

import { describe, it, expect } from 'vitest';
import {
  SEEDED_AUTHORS,
  SEEDED_CATEGORIES,
  CATEGORY_DISPLAY_NAMES,
  VALID_CATEGORY_IDS,
  inferCategory,
  isValidCategoryId,
  getCategoryDisplayName,
} from '../seedRefs.js';

describe('seeded constants', () => {
  it('has correct author IDs', () => {
    expect(SEEDED_AUTHORS.RAVI).toBe('author-ravi');
  });

  it('has correct category IDs', () => {
    expect(SEEDED_CATEGORIES.WEB_DEVELOPMENT).toBe('category-web-development');
    expect(SEEDED_CATEGORIES.AI_AUTOMATION).toBe('category-ai-automation');
    expect(SEEDED_CATEGORIES.PROGRAMMING).toBe('category-programming');
    expect(SEEDED_CATEGORIES.TECH_INSIGHTS).toBe('category-tech-insights');
  });

  it('has correct display names', () => {
    expect(CATEGORY_DISPLAY_NAMES['category-web-development']).toBe('Web Development');
    expect(CATEGORY_DISPLAY_NAMES['category-ai-automation']).toBe('AI & Automation');
    expect(CATEGORY_DISPLAY_NAMES['category-programming']).toBe('Programming');
    expect(CATEGORY_DISPLAY_NAMES['category-tech-insights']).toBe('Tech Insights');
  });

  it('has all valid category IDs', () => {
    expect(VALID_CATEGORY_IDS).toHaveLength(4);
    expect(VALID_CATEGORY_IDS).toContain('category-web-development');
    expect(VALID_CATEGORY_IDS).toContain('category-ai-automation');
    expect(VALID_CATEGORY_IDS).toContain('category-programming');
    expect(VALID_CATEGORY_IDS).toContain('category-tech-insights');
  });
});

describe('inferCategory', () => {
  describe('web development', () => {
    it('matches React-related topics', () => {
      expect(inferCategory('Building a React Dashboard', [])).toBe(
        SEEDED_CATEGORIES.WEB_DEVELOPMENT,
      );
    });

    it('matches Next.js topics', () => {
      expect(inferCategory('Next.js App Router Guide', [])).toBe(SEEDED_CATEGORIES.WEB_DEVELOPMENT);
    });

    it('matches frontend keywords', () => {
      expect(inferCategory('Guide', ['frontend', 'responsive'])).toBe(
        SEEDED_CATEGORIES.WEB_DEVELOPMENT,
      );
    });

    it('matches CSS and HTML topics', () => {
      expect(inferCategory('HTML and CSS Best Practices', [])).toBe(
        SEEDED_CATEGORIES.WEB_DEVELOPMENT,
      );
    });
  });

  describe('AI automation', () => {
    it('matches AI-related topics', () => {
      expect(inferCategory('AI-Powered Content Generation', [])).toBe(
        SEEDED_CATEGORIES.AI_AUTOMATION,
      );
    });

    it('matches machine learning topics', () => {
      expect(inferCategory('Machine Learning Basics', [])).toBe(SEEDED_CATEGORIES.AI_AUTOMATION);
    });

    it('matches automation keywords', () => {
      expect(inferCategory('How to Automate Your Workflow', [])).toBe(
        SEEDED_CATEGORIES.AI_AUTOMATION,
      );
    });

    it('matches LLM-related topics', () => {
      expect(inferCategory('Working with GPT and Claude', [])).toBe(
        SEEDED_CATEGORIES.AI_AUTOMATION,
      );
    });
  });

  describe('programming', () => {
    it('matches coding topics', () => {
      expect(inferCategory('Clean Code Principles', [])).toBe(SEEDED_CATEGORIES.PROGRAMMING);
    });

    it('matches algorithm topics', () => {
      expect(inferCategory('Algorithm Design Patterns', [])).toBe(SEEDED_CATEGORIES.PROGRAMMING);
    });

    it('matches testing topics', () => {
      expect(inferCategory('TDD Best Practices', [])).toBe(SEEDED_CATEGORIES.PROGRAMMING);
    });

    it('matches DevOps topics', () => {
      expect(inferCategory('CI/CD Pipeline Setup', [])).toBe(SEEDED_CATEGORIES.PROGRAMMING);
    });
  });

  describe('tech insights', () => {
    it('matches technology trends', () => {
      expect(inferCategory('Technology Trends for 2026', [])).toBe(SEEDED_CATEGORIES.TECH_INSIGHTS);
    });

    it('matches industry topics', () => {
      expect(inferCategory('The Future of Tech Industry', [])).toBe(
        SEEDED_CATEGORIES.TECH_INSIGHTS,
      );
    });

    it('matches cloud topics', () => {
      expect(inferCategory('Cloud Computing Overview', [])).toBe(SEEDED_CATEGORIES.TECH_INSIGHTS);
    });

    it('matches security topics', () => {
      expect(inferCategory('Security Best Practices', [])).toBe(SEEDED_CATEGORIES.TECH_INSIGHTS);
    });
  });

  describe('scoring and priority', () => {
    it('uses declared category order to break equal scores', () => {
      // AI, code, and web development each contribute one score; web development
      // wins because it is the first declared category at the shared maximum.
      expect(inferCategory('AI Code Assistant for Web Development', [])).toBe(
        SEEDED_CATEGORIES.WEB_DEVELOPMENT,
      );
    });

    it('defaults to tech insights when no strong match', () => {
      expect(inferCategory('Generic Topic', [])).toBe(SEEDED_CATEGORIES.TECH_INSIGHTS);
    });
  });

  describe('keyword matching', () => {
    it('uses keywords in scoring', () => {
      const result = inferCategory('Guide', ['react', 'javascript']);
      expect(result).toBe(SEEDED_CATEGORIES.WEB_DEVELOPMENT);
    });

    it('combines topic and keywords', () => {
      const result = inferCategory('Building with', ['ai', 'automation']);
      expect(result).toBe(SEEDED_CATEGORIES.AI_AUTOMATION);
    });
  });
});

describe('isValidCategoryId', () => {
  it('returns true for valid category IDs', () => {
    expect(isValidCategoryId('category-web-development')).toBe(true);
    expect(isValidCategoryId('category-ai-automation')).toBe(true);
    expect(isValidCategoryId('category-programming')).toBe(true);
    expect(isValidCategoryId('category-tech-insights')).toBe(true);
  });

  it('returns false for invalid category IDs', () => {
    expect(isValidCategoryId('invalid-category')).toBe(false);
    expect(isValidCategoryId('category-nonexistent')).toBe(false);
    expect(isValidCategoryId('')).toBe(false);
  });
});

describe('getCategoryDisplayName', () => {
  it('returns correct display names', () => {
    expect(getCategoryDisplayName('category-web-development')).toBe('Web Development');
    expect(getCategoryDisplayName('category-ai-automation')).toBe('AI & Automation');
    expect(getCategoryDisplayName('category-programming')).toBe('Programming');
    expect(getCategoryDisplayName('category-tech-insights')).toBe('Tech Insights');
  });

  it('returns Unknown for invalid IDs', () => {
    expect(getCategoryDisplayName('invalid')).toBe('Unknown');
    expect(getCategoryDisplayName('')).toBe('Unknown');
  });
});
