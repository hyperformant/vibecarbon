import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router';
import { AppSidebar } from '@/components/AppSidebar';
import { ContentSkeleton } from '@/components/ContentSkeleton';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { layoutVariantForPath } from '@/lib/route-layout';

export function SidebarLayout() {
  const { pathname } = useLocation();

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
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
