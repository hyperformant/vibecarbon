import {
  IconArrowLeft as ArrowLeft,
  IconCalendar as Calendar,
  IconTag as Tag,
} from '@tabler/icons-react';
import { Link, useParams } from 'react-router';
import { PROJECT_DISPLAY_NAME } from '@/components/Logo';
import { Nav } from '@/components/Nav';
import { SEO } from '@/components/SEO';
import FooterSection from '@/components/sections/footer';
import { Button } from '@/components/ui/button';
import { entries, getEntry } from '@/lib/changelog';

export function ChangelogIndex() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <SEO title="Changelog" description={`What's new in ${PROJECT_DISPLAY_NAME}.`} />

      <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
        <h1 className="mb-2 text-4xl font-black tracking-tight">Changelog</h1>
        <p className="mb-12 text-lg text-muted-foreground">
          New features, improvements, and fixes.
        </p>

        <div className="space-y-8">
          {entries.map((entry) => (
            <article key={entry.slug} className="group">
              <Link
                to={`/changelog/${entry.slug}`}
                className="block rounded-xl border p-6 transition-colors hover:bg-muted/50"
              >
                <h2 className="mb-2 text-xl font-bold tracking-tight group-hover:text-primary transition-colors">
                  {entry.frontmatter.title}
                </h2>
                <p className="mb-3 text-muted-foreground">{entry.frontmatter.description}</p>
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Calendar className="size-3.5" />
                    {formatDate(entry.frontmatter.date)}
                  </span>
                  {entry.frontmatter.version && (
                    <span className="flex items-center gap-1">
                      <Tag className="size-3.5" />v{entry.frontmatter.version}
                    </span>
                  )}
                </div>
              </Link>
            </article>
          ))}

          {entries.length === 0 && (
            <p className="py-12 text-center text-muted-foreground">
              No changelog entries yet. Check back soon!
            </p>
          )}
        </div>
      </main>

      <FooterSection />
    </div>
  );
}

export function ChangelogEntry() {
  const { slug } = useParams<{ slug: string }>();
  const entry = slug ? getEntry(slug) : undefined;

  if (!entry) {
    return (
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="mx-auto max-w-3xl px-6 pt-32 pb-24 text-center">
          <h1 className="mb-4 text-2xl font-bold">Entry not found</h1>
          <Button variant="outline" asChild>
            <Link to="/changelog" className="inline-flex items-center gap-2">
              <ArrowLeft className="size-4 shrink-0" />
              Back to changelog
            </Link>
          </Button>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <SEO title={entry.frontmatter.title} description={entry.frontmatter.description} />

      <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
        <Link
          to="/changelog"
          className="mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          Back to changelog
        </Link>

        <header className="mb-10">
          <h1 className="mb-3 text-4xl font-black tracking-tight">{entry.frontmatter.title}</h1>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <Calendar className="size-3.5" />
              {formatDate(entry.frontmatter.date)}
            </span>
            {entry.frontmatter.version && (
              <span className="flex items-center gap-1">
                <Tag className="size-3.5" />v{entry.frontmatter.version}
              </span>
            )}
          </div>
        </header>

        <article className="prose dark:prose-invert max-w-none">
          <entry.Component />
        </article>

        <div className="mt-16 border-t pt-8">
          <Button variant="outline" asChild>
            <Link to="/changelog" className="inline-flex items-center gap-2">
              <ArrowLeft className="size-4 shrink-0" />
              All releases
            </Link>
          </Button>
        </div>
      </main>

      <FooterSection />
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

/** Default export for React.lazy() route-level code splitting */
export default function ChangelogRoute() {
  const { slug } = useParams<{ slug: string }>();
  return slug ? <ChangelogEntry /> : <ChangelogIndex />;
}
