import {
  IconBook2 as BookOpen,
  IconChevronRight as ChevronRight,
  IconMenu2 as Menu,
  IconSearch as Search,
  IconX as X,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { Nav } from '@/components/Nav';
import { SEO } from '@/components/SEO';
import { SiteFooter } from '@/components/SiteFooter';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  type PackageManager,
  replacePackageManager,
  SHOW_PACKAGE_MANAGER_SWITCHER,
  usePackageManager,
} from '@/hooks/usePackageManager';
import { getPage, pages } from '@/lib/docs';
import { type SearchResult, searchDocs } from '@/lib/docs-search';
import { cn } from '@/lib/utils';

function DocsSearch({ onNavigate }: { onNavigate?: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const handleSearch = useCallback((value: string) => {
    setQuery(value);
    if (value.length >= 2) {
      setResults(searchDocs(value));
      setIsOpen(true);
    } else {
      setResults([]);
      setIsOpen(false);
    }
  }, []);

  const handleSelect = useCallback(
    (slug: string) => {
      navigate(`/docs/${slug}`);
      setQuery('');
      setIsOpen(false);
      onNavigate?.();
    },
    [navigate, onNavigate]
  );

  // Cmd+K / Ctrl+K keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setIsOpen(false);
        inputRef.current?.blur();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="relative mb-4">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          onFocus={() => query.length >= 2 && setIsOpen(true)}
          onBlur={() => setTimeout(() => setIsOpen(false), 200)}
          placeholder="Search docs..."
          className="w-full rounded-md border border-border bg-muted/50 pl-8 pr-12 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <kbd className="absolute right-2 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center gap-0.5 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          <span className="text-xs">⌘</span>K
        </kbd>
      </div>

      {/* Results dropdown */}
      {isOpen && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-lg">
          {results.map((result) => (
            <button
              key={result.slug}
              type="button"
              onMouseDown={() => handleSelect(result.slug)}
              className="w-full px-3 py-2 text-left text-sm hover:bg-accent transition-colors first:rounded-t-md last:rounded-b-md"
            >
              <div className="font-medium">{result.title}</div>
              <div className="text-xs text-muted-foreground truncate">{result.snippet}</div>
            </button>
          ))}
        </div>
      )}

      {isOpen && query.length >= 2 && results.length === 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover p-3 shadow-lg">
          <p className="text-sm text-muted-foreground">No results found.</p>
        </div>
      )}
    </div>
  );
}

function DocsSidebar({
  currentSlug,
  onNavigate,
}: {
  currentSlug: string;
  onNavigate?: () => void;
}) {
  return (
    <nav className="space-y-1">
      <DocsSearch onNavigate={onNavigate} />
      {pages.map((page) => (
        <Link
          key={page.slug}
          to={`/docs/${page.slug}`}
          onClick={onNavigate}
          className={cn(
            'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
            page.slug === currentSlug
              ? 'bg-primary/10 text-primary font-medium'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
          )}
        >
          {page.frontmatter.title}
        </Link>
      ))}
    </nav>
  );
}

export function DocsIndex() {
  // Redirect to the first doc page
  if (pages.length > 0) {
    return <Navigate to={`/docs/${pages[0].slug}`} replace />;
  }

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="mx-auto max-w-3xl px-6 pt-32 pb-24 text-center">
        <h1 className="mb-4 text-2xl font-bold">No documentation yet</h1>
        <p className="text-muted-foreground">Check back soon!</p>
      </main>
    </div>
  );
}

const PM_OPTIONS: PackageManager[] = ['npm', 'pnpm', 'bun'];

// Docs are authored against npm; only rewrite snippets that actually invoke
// it. Word-boundary matched so `npm_config_*` and the like are left alone.
const NPM_INVOCATION = /\bnpm\b/;

function PackageManagerSwitcher({
  pm,
  onChange,
}: {
  pm: PackageManager;
  onChange: (pm: PackageManager) => void;
}) {
  return (
    <ToggleGroup
      value={[pm]}
      onValueChange={(values) => {
        const next = values[0] as PackageManager | undefined;
        if (next) onChange(next);
      }}
      variant="outline"
      size="sm"
      className="shrink-0"
    >
      {PM_OPTIONS.map((option) => (
        <ToggleGroupItem key={option} value={option} className="text-xs px-2.5">
          {option}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function DocsPage() {
  const { slug } = useParams<{ slug: string }>();
  const page = slug ? getPage(slug) : undefined;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pm, setPm] = usePackageManager();

  const mdxComponents = useMemo(
    () => ({
      code: ((rawProps: unknown) => {
        const { children, ...props } = rawProps as Record<string, unknown> & {
          children?: React.ReactNode;
        };
        const content =
          typeof children === 'string' && NPM_INVOCATION.test(children)
            ? replacePackageManager(children, pm)
            : children;
        return <code {...props}>{content}</code>;
      }) as React.ComponentType<unknown>,
    }),
    [pm]
  );

  if (!page) {
    return (
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="mx-auto max-w-3xl px-6 pt-32 pb-24 text-center">
          <h1 className="mb-4 text-2xl font-bold">Page not found</h1>
          <Button variant="outline" asChild>
            <Link to="/docs" className="inline-flex items-center gap-2">
              <BookOpen className="size-4 shrink-0" />
              Browse docs
            </Link>
          </Button>
        </main>
      </div>
    );
  }

  // Find prev/next pages
  const currentIndex = pages.findIndex((p) => p.slug === slug);
  const prevPage = currentIndex > 0 ? pages[currentIndex - 1] : null;
  const nextPage = currentIndex < pages.length - 1 ? pages[currentIndex + 1] : null;

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <SEO title={page.frontmatter.title} description={page.frontmatter.description} />

      <div className="mx-auto max-w-7xl px-6 pt-28 pb-24">
        <div className="flex gap-10">
          {/* Desktop sidebar */}
          <aside className="hidden lg:block w-56 shrink-0 sticky top-28 h-[calc(100vh-8rem)] overflow-y-auto">
            <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Documentation
            </h3>
            <DocsSidebar currentSlug={slug || ''} />
          </aside>

          {/* Mobile sidebar toggle */}
          <Button
            variant="outline"
            size="icon-sm"
            className="fixed bottom-6 right-6 z-50 lg:hidden shadow-lg"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            {sidebarOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </Button>

          {/* Mobile sidebar overlay */}
          {sidebarOpen && (
            <div
              role="button"
              tabIndex={0}
              aria-label="Close sidebar"
              className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm lg:hidden"
              onClick={() => setSidebarOpen(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setSidebarOpen(false);
              }}
            >
              <aside
                className="absolute left-0 top-20 bottom-0 w-64 bg-background border-r p-6 overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={() => {}}
              >
                <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Documentation
                </h3>
                <DocsSidebar currentSlug={slug || ''} onNavigate={() => setSidebarOpen(false)} />
              </aside>
            </div>
          )}

          {/* Main content */}
          <main className="min-w-0 flex-1">
            <header className="mb-10">
              <div className="flex items-start justify-between gap-4">
                <h1 className="mb-3 text-4xl font-black tracking-tight">
                  {page.frontmatter.title}
                </h1>
                {SHOW_PACKAGE_MANAGER_SWITCHER && (
                  <PackageManagerSwitcher pm={pm} onChange={setPm} />
                )}
              </div>
              {page.frontmatter.description && (
                <p className="text-lg text-muted-foreground">{page.frontmatter.description}</p>
              )}
            </header>

            <article className="prose dark:prose-invert max-w-none">
              <page.Component components={mdxComponents} />
            </article>

            {/* Prev / Next navigation */}
            <div className="mt-16 border-t pt-8 flex items-center justify-between gap-4">
              {prevPage ? (
                <Link
                  to={`/docs/${prevPage.slug}`}
                  className="group flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronRight className="size-4 rotate-180 group-hover:-translate-x-0.5 transition-transform" />
                  {prevPage.frontmatter.title}
                </Link>
              ) : (
                <div />
              )}
              {nextPage && (
                <Link
                  to={`/docs/${nextPage.slug}`}
                  className="group flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  {nextPage.frontmatter.title}
                  <ChevronRight className="size-4 group-hover:translate-x-0.5 transition-transform" />
                </Link>
              )}
            </div>
          </main>
        </div>
      </div>

      <DocsFooter />
    </div>
  );
}

/** Default export for React.lazy() route-level code splitting */
export default function DocsRoute() {
  const { slug } = useParams<{ slug: string }>();
  return slug ? <DocsPage /> : <DocsIndex />;
}

function DocsFooter() {
  return (
    <SiteFooter
      links={[
        { to: '/', label: 'Home' },
        { to: '/docs', label: 'Docs' },
        { to: '/blog', label: 'Blog' },
        { to: '/privacy', label: 'Privacy' },
        { to: '/terms', label: 'Terms' },
      ]}
    />
  );
}
