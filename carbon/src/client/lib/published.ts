/**
 * Draft gate for content collections. The build-time generators
 * (scripts/generate-seo.ts, generate-sitemap.ts, generate-rss.ts) exclude
 * `draft: true` pages from every crawler artifact; this is the browser-facing
 * half of the same rule, so a draft committed to content/ never renders in
 * the client either.
 */
export function publishedPosts<T extends { frontmatter: { draft?: boolean } }>(all: T[]): T[] {
  return all.filter((post) => !post.frontmatter.draft);
}
