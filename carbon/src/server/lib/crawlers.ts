/**
 * AI / search crawler registry — the single source of truth for "which bot is
 * this?" across the server.
 *
 * Used by `middleware/crawler-tracking.ts` (to record hits) and by
 * `routes/v1/admin/crawlers.ts` (to label them on the AI Visibility page).
 * `lib/seo.ts` and `scripts/generate-seo.ts` reference this list in prose —
 * keep this file the place the names actually live.
 *
 * Categories:
 *   - `ai-training`  — fetches corpus material for model training / grounding
 *                      datasets (GPTBot, ClaudeBot, CCBot, Google-Extended…).
 *   - `ai-search`    — fetches a page to answer a live user question, i.e. the
 *                      surface that can actually cite you (OAI-SearchBot,
 *                      PerplexityBot, ChatGPT-User…).
 *   - `search`       — classic web-search indexing (Googlebot, Bingbot).
 *
 * The distinction is the whole point of the feature: `ai-search` hits are the
 * ones that turn into referral traffic, `ai-training` hits are not.
 */

export type CrawlerCategory = 'ai-training' | 'ai-search' | 'search';

export interface Crawler {
  /** Display name, and the value stored in `crawler_hits.crawler`. */
  name: string;
  /** Lowercase substring searched for in the User-Agent header. */
  match: string;
  /** Company operating the crawler. */
  operator: string;
  category: CrawlerCategory;
}

/**
 * ORDER IS LOAD-BEARING: `classifyCrawler` returns the FIRST match, so every
 * entry whose `match` contains another entry's `match` must come first.
 * Concretely, `applebot-extended` contains `applebot` — swapping those two
 * lines silently reclassifies every Apple AI-training fetch as plain search.
 * The same specific-before-generic rule is why `Google-Extended` precedes
 * `Googlebot`.
 */
export const CRAWLERS: readonly Crawler[] = [
  // --- OpenAI ---
  { name: 'GPTBot', match: 'gptbot', operator: 'OpenAI', category: 'ai-training' },
  { name: 'OAI-SearchBot', match: 'oai-searchbot', operator: 'OpenAI', category: 'ai-search' },
  { name: 'ChatGPT-User', match: 'chatgpt-user', operator: 'OpenAI', category: 'ai-search' },

  // --- Anthropic ---
  { name: 'ClaudeBot', match: 'claudebot', operator: 'Anthropic', category: 'ai-training' },
  { name: 'Claude-User', match: 'claude-user', operator: 'Anthropic', category: 'ai-search' },

  // --- Perplexity ---
  { name: 'PerplexityBot', match: 'perplexitybot', operator: 'Perplexity', category: 'ai-search' },
  {
    name: 'Perplexity-User',
    match: 'perplexity-user',
    operator: 'Perplexity',
    category: 'ai-search',
  },

  // --- Microsoft ---
  { name: 'Bingbot', match: 'bingbot', operator: 'Microsoft', category: 'search' },

  // --- Google (specific before generic) ---
  {
    name: 'Google-Extended',
    match: 'google-extended',
    operator: 'Google',
    category: 'ai-training',
  },
  { name: 'Googlebot', match: 'googlebot', operator: 'Google', category: 'search' },

  // --- Amazon ---
  { name: 'Amazonbot', match: 'amazonbot', operator: 'Amazon', category: 'ai-training' },

  // --- Apple (specific before generic) ---
  {
    name: 'Applebot-Extended',
    match: 'applebot-extended',
    operator: 'Apple',
    category: 'ai-training',
  },
  { name: 'Applebot', match: 'applebot', operator: 'Apple', category: 'search' },

  // --- Others ---
  { name: 'Bytespider', match: 'bytespider', operator: 'ByteDance', category: 'ai-training' },
  { name: 'CCBot', match: 'ccbot', operator: 'Common Crawl', category: 'ai-training' },
  {
    name: 'meta-externalagent',
    match: 'meta-externalagent',
    operator: 'Meta',
    category: 'ai-training',
  },
];

/**
 * Identify the crawler behind a User-Agent header, or `null` for anything that
 * isn't a known bot (which is the overwhelmingly common case — browsers).
 *
 * Case-insensitive substring match against the ordered registry above.
 */
export function classifyCrawler(userAgent: string | undefined): Crawler | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  for (const crawler of CRAWLERS) {
    if (ua.includes(crawler.match)) return crawler;
  }
  return null;
}

/** Lookup by stored `crawler_hits.crawler` value (the registry's `name`). */
export function findCrawlerByName(name: string): Crawler | null {
  return CRAWLERS.find((c) => c.name === name) ?? null;
}
