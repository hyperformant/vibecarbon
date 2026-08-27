import { describe, expect, it } from 'vitest';
import { publishedPosts } from '@/lib/published';

const post = (slug: string, draft?: boolean) => ({
  slug,
  frontmatter: { title: slug, description: '', date: '2026-08-26', ...(draft !== undefined ? { draft } : {}) },
});

describe('publishedPosts', () => {
  it('excludes posts with draft: true frontmatter', () => {
    const result = publishedPosts([post('live'), post('wip', true)]);
    expect(result.map((p) => p.slug)).toEqual(['live']);
  });

  it('keeps posts with draft absent or false', () => {
    const result = publishedPosts([post('a'), post('b', false)]);
    expect(result.map((p) => p.slug)).toEqual(['a', 'b']);
  });
});
