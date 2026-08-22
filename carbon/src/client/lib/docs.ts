import type { ComponentType } from 'react';

/** Props accepted by compiled MDX components (subset we use) */
export type MdxProps = {
  components?: Record<string, ComponentType<unknown>>;
};

export interface DocPage {
  slug: string;
  frontmatter: {
    title: string;
    description: string;
    order?: number;
  };
  Component: ComponentType<MdxProps>;
}

// Eagerly import all MDX files from content/docs/
const modules = import.meta.glob<{
  default: ComponentType<MdxProps>;
  frontmatter: DocPage['frontmatter'];
}>('/../../content/docs/*.mdx', { eager: true });

export const pages: DocPage[] = Object.entries(modules)
  .map(([filepath, mod]) => {
    const slug = (filepath.split('/').pop() ?? '').replace('.mdx', '');
    return {
      slug,
      frontmatter: mod.frontmatter,
      Component: mod.default,
    };
  })
  .sort((a, b) => (a.frontmatter.order ?? 99) - (b.frontmatter.order ?? 99));

export function getPage(slug: string): DocPage | undefined {
  return pages.find((p) => p.slug === slug);
}
