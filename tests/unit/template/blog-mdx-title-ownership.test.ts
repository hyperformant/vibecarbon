/**
 * The Blog layout owns the post title.
 *
 *   carbon/src/client/pages/Blog.tsx   renders <h1>{frontmatter.title}</h1>
 *   carbon/scripts/generate-seo.ts     prepends `# {title}` to the crawler
 *                                      mirror when the body lacks an opening H1
 *
 * A `# Title` line at the top of a post's MDX body therefore renders the title
 * TWICE on the reader-facing page (layout header + article body) while adding
 * nothing for crawlers — the mirror generator already covers the no-H1 case.
 * Every stock post shipped with exactly this duplication until 2026-08-29;
 * this census keeps the next sample post (and the next copy-pasted real one)
 * from reintroducing it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BLOG_DIR = join(__dirname, '../../../carbon/content/blog');

describe('blog MDX title ownership', () => {
  const posts = readdirSync(BLOG_DIR).filter((f) => f.endsWith('.mdx'));

  it('ships at least one sample post (else this census guards nothing)', () => {
    expect(posts.length).toBeGreaterThan(0);
  });

  it.each(posts)('%s does not open its body with an H1 — the layout renders the title', (file) => {
    const source = readFileSync(join(BLOG_DIR, file), 'utf-8');
    const body = source.replace(/^---\n[\s\S]*?\n---\n/, '');
    const firstContentLine = body.split('\n').find((line) => line.trim() !== '') ?? '';
    expect(
      firstContentLine.startsWith('# '),
      `${file} opens with "${firstContentLine}" — drop the H1; Blog.tsx renders frontmatter.title as the page heading`,
    ).toBe(false);
  });
});
