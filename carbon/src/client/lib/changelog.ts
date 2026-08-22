import type { ComponentType } from 'react';

export interface ChangelogEntry {
  slug: string;
  frontmatter: {
    title: string;
    description: string;
    date: string;
    version?: string;
  };
  Component: ComponentType;
}

// Eagerly import all MDX files from content/changelog/
const modules = import.meta.glob<{
  default: ComponentType;
  frontmatter: ChangelogEntry['frontmatter'];
}>('/../../content/changelog/*.mdx', { eager: true });

export const entries: ChangelogEntry[] = Object.entries(modules)
  .map(([filepath, mod]) => {
    const slug = (filepath.split('/').pop() ?? '').replace('.mdx', '');
    return {
      slug,
      frontmatter: mod.frontmatter,
      Component: mod.default,
    };
  })
  .sort((a, b) => new Date(b.frontmatter.date).getTime() - new Date(a.frontmatter.date).getTime());

export function getEntry(slug: string): ChangelogEntry | undefined {
  return entries.find((e) => e.slug === slug);
}
