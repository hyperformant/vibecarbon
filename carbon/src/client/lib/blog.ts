import type { ComponentType } from 'react';
import { publishedPosts } from '@/lib/published';

export interface BlogPost {
  slug: string;
  frontmatter: {
    title: string;
    description: string;
    date: string;
    author?: string;
    draft?: boolean;
  };
  Component: ComponentType;
}

// Import all MDX files from content/blog/
// These are loaded eagerly within this chunk, but since Blog.tsx is lazy-loaded
// via React.lazy(), none of this code enters the main bundle.
const modules = import.meta.glob<{
  default: ComponentType;
  frontmatter: BlogPost['frontmatter'];
}>('/../../content/blog/*.mdx', { eager: true });

export const posts: BlogPost[] = publishedPosts(
  Object.entries(modules).map(([filepath, mod]) => {
    const slug = (filepath.split('/').pop() ?? '').replace('.mdx', '');
    return {
      slug,
      frontmatter: mod.frontmatter,
      Component: mod.default,
    };
  })
).sort((a, b) => new Date(b.frontmatter.date).getTime() - new Date(a.frontmatter.date).getTime());

export function getPost(slug: string): BlogPost | undefined {
  return posts.find((p) => p.slug === slug);
}
