import { type ReactNode, Suspense } from 'react';
import { Outlet, useLocation } from 'react-router';
import { AppSidebar } from '@/components/AppSidebar';
import { ContentSkeleton } from '@/components/ContentSkeleton';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { layoutVariantForPath } from '@/lib/route-layout';

export function SidebarLayout({ banner }: { banner?: ReactNode }) {
  const { pathname } = useLocation();

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        {banner}
        <Suspense
          key={pathname}
          fallback={<ContentSkeleton variant={layoutVariantForPath(pathname)} />}
        >
          <Outlet />
        </Suspense>
      </SidebarInset>
    </SidebarProvider>
  );
}
