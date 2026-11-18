// Index and entry pages for an MDX collection (the blog and the changelog).
// Built from Shadcn's Button; no Launch UI block covers a dated content list.
import { IconArrowLeft as ArrowLeft, IconCalendar as Calendar } from '@tabler/icons-react';
import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router';
import { Nav } from '@/components/Nav';
import { SEO } from '@/components/SEO';
import FooterSection from '@/components/sections/footer';
import { Button } from '@/components/ui/button';

/** What every collection item has; a collection may add frontmatter fields. */
export interface ContentItem {
  slug: string;
  frontmatter: { title: string; description: string; date: string };
  Component: ComponentType;
}

interface ContentIndexProps<T extends ContentItem> {
  /** Route of the index, e.g. `/blog`; an item lives at `${basePath}/${slug}`. */
  basePath: string;
  title: string;
  tagline: string;
  seoDescription: string;
  items: T[];
  emptyText: string;
  /** Extra meta shown after the date (author, version), or nothing. */
  renderMeta: (item: T) => ReactNode;
}

export function ContentIndex<T extends ContentItem>({
  basePath,
  title,
  tagline,
  seoDescription,
  items,
  emptyText,
  renderMeta,
}: ContentIndexProps<T>) {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <SEO title={title} description={seoDescription} />

      <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
        <h1 className="mb-2 text-4xl font-black tracking-tight">{title}</h1>
        <p className="mb-12 text-lg text-muted-foreground">{tagline}</p>

        <div className="space-y-8">
          {items.map((item) => (
            <article key={item.slug} className="group">
              <Link
                to={`${basePath}/${item.slug}`}
                className="block rounded-xl border p-6 transition-colors hover:bg-muted/50"
              >
                <h2 className="mb-2 text-xl font-bold tracking-tight group-hover:text-primary transition-colors">
                  {item.frontmatter.title}
                </h2>
                <p className="mb-3 text-muted-foreground">{item.frontmatter.description}</p>
                <MetaLine date={item.frontmatter.date}>{renderMeta(item)}</MetaLine>
              </Link>
            </article>
          ))}

          {items.length === 0 && (
            <p className="py-12 text-center text-muted-foreground">{emptyText}</p>
          )}
        </div>
      </main>

      <FooterSection />
    </div>
  );
}

interface ContentEntryProps<T extends ContentItem> {
  basePath: string;
  /** The item for the route's slug, or undefined when there is none. */
  item: T | undefined;
  notFoundText: string;
  backLabel: string;
  allLabel: string;
  renderMeta: (item: T) => ReactNode;
}

export function ContentEntry<T extends ContentItem>({
  basePath,
  item,
  notFoundText,
  backLabel,
  allLabel,
  renderMeta,
}: ContentEntryProps<T>) {
  if (!item) {
    return (
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="mx-auto max-w-3xl px-6 pt-32 pb-24 text-center">
          <h1 className="mb-4 text-2xl font-bold">{notFoundText}</h1>
          <Button variant="outline" asChild>
            <Link to={basePath} className="inline-flex items-center gap-2">
              <ArrowLeft className="size-4 shrink-0" />
              {backLabel}
            </Link>
          </Button>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <SEO title={item.frontmatter.title} description={item.frontmatter.description} />

      <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
        <Link
          to={basePath}
          className="mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          {backLabel}
        </Link>

        <header className="mb-10">
          <h1 className="mb-3 text-4xl font-black tracking-tight">{item.frontmatter.title}</h1>
          <MetaLine date={item.frontmatter.date}>{renderMeta(item)}</MetaLine>
        </header>

        <article className="prose dark:prose-invert max-w-none">
          <item.Component />
        </article>

        <div className="mt-16 border-t pt-8">
          <Button variant="outline" asChild>
            <Link to={basePath} className="inline-flex items-center gap-2">
              <ArrowLeft className="size-4 shrink-0" />
              {allLabel}
            </Link>
          </Button>
        </div>
      </main>

      <FooterSection />
    </div>
  );
}

function MetaLine({ date, children }: { date: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 text-sm text-muted-foreground">
      <span className="flex items-center gap-1">
        <Calendar className="size-3.5" />
        {formatDate(date)}
      </span>
      {children}
    </div>
  );
}

function formatDate(dateStr: string): string {
  // Frontmatter dates are calendar dates; a bare YYYY-MM-DD parses as UTC
  // midnight, so render in UTC or every viewer west of UTC sees the prior day.
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
