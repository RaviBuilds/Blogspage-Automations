/**
 * Seeded reference data for Blogspage Agency.
 *
 * These are the stable IDs that exist in the production Sanity dataset
 * and should be used by the automation for author and category references.
 *
 * @see knowledge/automation-integration.md - Required Sanity fields
 */

/** Seeded author IDs in the Blogspage Agency dataset. */
export const SEEDED_AUTHORS = {
  /** Default author for automated posts. */
  RAVI: 'author-ravi',
} as const;

/** Seeded category IDs in the Blogspage Agency dataset. */
export const SEEDED_CATEGORIES = {
  WEB_DEVELOPMENT: 'category-web-development',
  AI_AUTOMATION: 'category-ai-automation',
  PROGRAMMING: 'category-programming',
  TECH_INSIGHTS: 'category-tech-insights',
} as const;

/** Category display names for keyword matching. */
export const CATEGORY_DISPLAY_NAMES: Record<string, string> = {
  [SEEDED_CATEGORIES.WEB_DEVELOPMENT]: 'Web Development',
  [SEEDED_CATEGORIES.AI_AUTOMATION]: 'AI & Automation',
  [SEEDED_CATEGORIES.PROGRAMMING]: 'Programming',
  [SEEDED_CATEGORIES.TECH_INSIGHTS]: 'Tech Insights',
} as const;

/** All valid category IDs. */
export const VALID_CATEGORY_IDS = Object.values(SEEDED_CATEGORIES) as string[];

/**
 * Determines the best category for a topic based on keywords.
 *
 * @param topic - The article topic.
 * @param keywords - SEO keywords for the article.
 * @returns The most appropriate category ID, or the default category.
 */
export function inferCategory(topic: string, keywords: readonly string[]): string {
  const combinedText = `${topic} ${keywords.join(' ')}`.toLowerCase();

  // Keyword patterns for each category
  const patterns: Record<
    (typeof SEEDED_CATEGORIES)[keyof typeof SEEDED_CATEGORIES],
    readonly string[]
  > = {
    [SEEDED_CATEGORIES.WEB_DEVELOPMENT]: [
      'react',
      'next.js',
      'nextjs',
      'vue',
      'angular',
      'svelte',
      'frontend',
      'backend',
      'full-stack',
      'web app',
      'website',
      'html',
      'css',
      'javascript',
      'typescript',
      'node',
      'api',
      'responsive',
      'web performance',
      'web development',
    ],
    [SEEDED_CATEGORIES.AI_AUTOMATION]: [
      'ai',
      'artificial intelligence',
      'machine learning',
      'ml',
      'automation',
      'automate',
      'llm',
      'gpt',
      'chatgpt',
      'claude',
      'neural',
      'deep learning',
      'nlp',
      'computer vision',
      'intelligent',
      'smart',
      'autonomous',
      'ai-powered',
    ],
    [SEEDED_CATEGORIES.PROGRAMMING]: [
      'code',
      'coding',
      'programming',
      'developer',
      'software',
      'algorithm',
      'data structure',
      'debug',
      'testing',
      'tdd',
      'clean code',
      'refactor',
      'design pattern',
      'architecture',
      'git',
      'version control',
      'ci/cd',
      'devops',
    ],
    [SEEDED_CATEGORIES.TECH_INSIGHTS]: [
      'technology',
      'tech',
      'industry',
      'trend',
      'future',
      'innovation',
      'digital',
      'cloud',
      'security',
      'privacy',
      'open source',
      'startup',
      'business',
      'productivity',
    ],
  };

  // Score each category
  const scores: Record<(typeof SEEDED_CATEGORIES)[keyof typeof SEEDED_CATEGORIES], number> = {
    [SEEDED_CATEGORIES.WEB_DEVELOPMENT]: 0,
    [SEEDED_CATEGORIES.AI_AUTOMATION]: 0,
    [SEEDED_CATEGORIES.PROGRAMMING]: 0,
    [SEEDED_CATEGORIES.TECH_INSIGHTS]: 0,
  };

  for (const categoryId of Object.values(SEEDED_CATEGORIES)) {
    scores[categoryId] = patterns[categoryId].reduce((score, pattern) => {
      const regex = new RegExp(`\\b${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      const matches = combinedText.match(regex);
      return score + (matches ? matches.length : 0);
    }, 0);
  }

  // Find the highest scoring category
  let maxScore = 0;
  let bestCategory: (typeof SEEDED_CATEGORIES)[keyof typeof SEEDED_CATEGORIES] =
    SEEDED_CATEGORIES.TECH_INSIGHTS; // Default

  for (const categoryId of Object.values(SEEDED_CATEGORIES)) {
    const score = scores[categoryId];
    if (score > maxScore) {
      maxScore = score;
      bestCategory = categoryId;
    }
  }

  return bestCategory;
}

/**
 * Validates that a category ID is one of the seeded categories.
 *
 * @param categoryId - The category ID to validate.
 * @returns True if the category ID is valid.
 */
export function isValidCategoryId(categoryId: string): boolean {
  return VALID_CATEGORY_IDS.includes(categoryId);
}

/**
 * Gets the display name for a category ID.
 *
 * @param categoryId - The category ID.
 * @returns The display name, or 'Unknown' if not found.
 */
export function getCategoryDisplayName(categoryId: string): string {
  return CATEGORY_DISPLAY_NAMES[categoryId] ?? 'Unknown';
}
