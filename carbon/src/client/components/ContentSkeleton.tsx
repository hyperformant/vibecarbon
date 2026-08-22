import { type LayoutVariant, maxWidthClasses, variantToWidth } from '@/components/ContentPanel';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Route-level Suspense fallback for lazy sidebar pages. It renders before the
 * page chunk loads, so it can't mirror the page's internal layout — but it does
 * match the page's *width* (via `variant`, derived from the URL in SidebarLayout)
 * and the PageHeader + ContentPanel padding, so content doesn't jump on load.
 */
export function ContentSkeleton({ variant = 'default' }: { variant?: LayoutVariant }) {
  const width = maxWidthClasses[variantToWidth[variant]];

  return (
    <>
      {/* Mirrors PageHeader: h-10, mt-6, pr-8 */}
      <header className="mt-6 flex h-10 items-center pr-8">
        <Skeleton className="h-5 w-40 rounded-md" />
      </header>
      {/* Mirrors ContentPanel: flex-1 pr-8 py-6 + the variant max-width */}
      <div className="flex-1 py-6 pr-8">
        <div className={cn(width, 'space-y-6')}>
          <Skeleton className="h-32 w-full rounded-xl" />
          <div className="grid grid-cols-2 gap-4">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </div>
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    </>
  );
}
