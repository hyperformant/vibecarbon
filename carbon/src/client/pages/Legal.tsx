import type { ComponentType } from 'react';
import { Navigate, useLocation, useParams } from 'react-router';
import { PROJECT_DISPLAY_NAME } from '@/components/Logo';
import { Nav } from '@/components/Nav';
import { SEO } from '@/components/SEO';
import { SiteFooter } from '@/components/SiteFooter';
import type { MdxProps } from '@/lib/docs';

// Raw {{PLACEHOLDER}} tokens inside MDX bodies are parsed as JSX expressions
// and crash at render, so the legal pages take template values as props
// instead ({props.projectName}). The fallback string below is substituted by
// `vibecarbon create`, same as PROJECT_DISPLAY_NAME in Logo.tsx.
const ADMIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL ?? '{{ADMIN_EMAIL}}';

type LegalMdxProps = MdxProps & { projectName: string; adminEmail: string };

interface LegalPage {
  slug: string;
  title: string;
  description: string;
  Component: ComponentType<LegalMdxProps>;
}

const legalModules = import.meta.glob<{
  default: ComponentType<LegalMdxProps>;
  frontmatter: { title: string; description: string };
}>('/../../content/docs/legal/*.mdx', { eager: true });

const legalPages: LegalPage[] = Object.entries(legalModules).map(([filepath, mod]) => {
  const slug = (filepath.split('/').pop() ?? '').replace('.mdx', '');
  return {
    slug,
    title: mod.frontmatter.title,
    description: mod.frontmatter.description,
    Component: mod.default,
  };
});

/** Map short URL paths to MDX file slugs */
const pathToSlug: Record<string, string> = {
  '/privacy': 'privacy-policy',
  '/terms': 'terms-of-service',
};

function getLegalPage(slug: string): LegalPage | undefined {
  return legalPages.find((p) => p.slug === slug);
}

export default function LegalRoute() {
  const { slug: paramSlug } = useParams<{ slug: string }>();
  const { pathname } = useLocation();

  // Resolve slug from param (/legal/:slug) or from path alias (/privacy, /terms)
  const slug = paramSlug || pathToSlug[pathname];

  if (!slug) {
    return <Navigate to="/privacy" replace />;
  }

  const page = getLegalPage(slug);

  if (!page) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <SEO title={page.title} description={page.description} />

      <div className="mx-auto max-w-3xl px-6 pt-28 pb-24">
        <header className="mb-10">
          <h1 className="mb-3 text-4xl font-black tracking-tight">{page.title}</h1>
          <p className="text-lg text-muted-foreground">{page.description}</p>
        </header>

        <article className="prose dark:prose-invert max-w-none">
          <page.Component projectName={PROJECT_DISPLAY_NAME} adminEmail={ADMIN_EMAIL} />
        </article>
      </div>

      <SiteFooter />
    </div>
  );
}
