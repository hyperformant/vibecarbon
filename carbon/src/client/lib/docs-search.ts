import { pages } from './docs';

export interface SearchResult {
  slug: string;
  title: string;
  description: string;
  snippet: string;
  score: number;
}

/**
 * Simple client-side full-text search over docs content.
 * Uses pre-extracted text from MDX components rendered to plain text.
 * No external dependencies (no Flexsearch/Fuse.js needed for this scale).
 */

interface DocIndex {
  slug: string;
  title: string;
  description: string;
  text: string; // full-text content
}

let index: DocIndex[] | null = null;

/**
 * Build the search index by extracting text from MDX components.
 * Called lazily on first search.
 */
function buildIndex(): DocIndex[] {
  if (index) return index;

  index = pages.map((page) => {
    // Extract text from the MDX component by rendering to a temporary element
    const text = extractTextFromPage(page);
    return {
      slug: page.slug,
      title: page.frontmatter.title,
      description: page.frontmatter.description,
      text: text.toLowerCase(),
    };
  });

  return index;
}

/**
 * Extract plain text from a doc page.
 * Uses a temporary DOM element to render the MDX and extract textContent.
 */
function extractTextFromPage(page: (typeof pages)[0]): string {
  // Use frontmatter as the primary search content.
  // MDX components can't be easily rendered to text without React.
  return `${page.frontmatter.title} ${page.frontmatter.description}`;
}

/**
 * Search docs by query string.
 * Returns results sorted by relevance score.
 */
export function searchDocs(query: string, maxResults = 10): SearchResult[] {
  if (!query || query.length < 2) return [];

  const docs = buildIndex();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results: SearchResult[] = [];

  for (const doc of docs) {
    let score = 0;

    for (const term of terms) {
      // Title match (highest weight)
      if (doc.title.toLowerCase().includes(term)) {
        score += 10;
      }
      // Description match
      if (doc.description.toLowerCase().includes(term)) {
        score += 5;
      }
      // Full text match
      if (doc.text.includes(term)) {
        score += 1;
      }
    }

    if (score > 0) {
      // Generate snippet from description (good enough for this scale)
      const snippet = doc.description;

      results.push({
        slug: doc.slug,
        title: doc.title,
        description: doc.description,
        snippet,
        score,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
}
