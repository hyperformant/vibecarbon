import {
  IconArrowLeft as ArrowLeft,
  IconCalendar as Calendar,
  IconUser as User,
} from '@tabler/icons-react';
import { Link, useParams } from 'react-router';
import { PROJECT_DISPLAY_NAME } from '@/components/Logo';
import { Nav } from '@/components/Nav';
import { SEO } from '@/components/SEO';
import { SiteFooter } from '@/components/SiteFooter';
import { Button } from '@/components/ui/button';
import { getPost, posts } from '@/lib/blog';

export function BlogIndex() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <SEO title="Blog" description={`Latest updates and guides from ${PROJECT_DISPLAY_NAME}.`} />

      <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
        <h1 className="mb-2 text-4xl font-black tracking-tight">Blog</h1>
        <p className="mb-12 text-lg text-muted-foreground">
          Updates, guides, and insights from the team.
        </p>

        <div className="space-y-8">
          {posts.map((post) => (
            <article key={post.slug} className="group">
              <Link
                to={`/blog/${post.slug}`}
                className="block rounded-xl border p-6 transition-colors hover:bg-muted/50"
              >
                <h2 className="mb-2 text-xl font-bold tracking-tight group-hover:text-primary transition-colors">
                  {post.frontmatter.title}
                </h2>
                <p className="mb-3 text-muted-foreground">{post.frontmatter.description}</p>
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Calendar className="size-3.5" />
                    {formatDate(post.frontmatter.date)}
                  </span>
                  {post.frontmatter.author && (
                    <span className="flex items-center gap-1">
                      <User className="size-3.5" />
                      {post.frontmatter.author}
                    </span>
                  )}
                </div>
              </Link>
            </article>
          ))}

          {posts.length === 0 && (
            <p className="py-12 text-center text-muted-foreground">
              No posts yet. Check back soon!
            </p>
          )}
        </div>
      </main>

      <BlogFooter />
    </div>
  );
}

export function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const post = slug ? getPost(slug) : undefined;

  if (!post) {
    return (
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="mx-auto max-w-3xl px-6 pt-32 pb-24 text-center">
          <h1 className="mb-4 text-2xl font-bold">Post not found</h1>
          <Button variant="outline" asChild>
            <Link to="/blog" className="inline-flex items-center gap-2">
              <ArrowLeft className="size-4 shrink-0" />
              Back to blog
            </Link>
          </Button>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <SEO title={post.frontmatter.title} description={post.frontmatter.description} />

      <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
        <Link
          to="/blog"
          className="mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          Back to blog
        </Link>

        <header className="mb-10">
          <h1 className="mb-3 text-4xl font-black tracking-tight">{post.frontmatter.title}</h1>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <Calendar className="size-3.5" />
              {formatDate(post.frontmatter.date)}
            </span>
            {post.frontmatter.author && (
              <span className="flex items-center gap-1">
                <User className="size-3.5" />
                {post.frontmatter.author}
              </span>
            )}
          </div>
        </header>

        <article className="prose dark:prose-invert max-w-none">
          <post.Component />
        </article>

        <div className="mt-16 border-t pt-8">
          <Button variant="outline" asChild>
            <Link to="/blog" className="inline-flex items-center gap-2">
              <ArrowLeft className="size-4 shrink-0" />
              All posts
            </Link>
          </Button>
        </div>
      </main>

      <BlogFooter />
    </div>
  );
}

function BlogFooter() {
  return (
    <SiteFooter
      links={[
        { to: '/', label: 'Home' },
        { to: '/blog', label: 'Blog' },
      ]}
    />
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
export default function BlogRoute() {
  const { slug } = useParams<{ slug: string }>();
  return slug ? <BlogPost /> : <BlogIndex />;
}
