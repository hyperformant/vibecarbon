import type * as React from 'react';

import { cn } from '@/lib/utils';

/*
 * Feature-grid item primitive from Launch UI (MIT). Vendored under this name
 * because the template already ships an unrelated Shadcn `Item` primitive at
 * ui/item.tsx — this is the simpler icon + title + description card the Launch
 * UI "items" block composes. Pure layout over Shadcn tokens; nothing to convert.
 */

function FeatureItem({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="feature-item"
      className={cn('text-foreground flex flex-col gap-4 p-4', className)}
      {...props}
    />
  );
}

function FeatureItemTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return (
    <h3
      data-slot="feature-item-title"
      className={cn('text-sm leading-none font-semibold tracking-tight sm:text-base', className)}
      {...props}
    />
  );
}

function FeatureItemDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="feature-item-description"
      className={cn(
        'text-muted-foreground flex max-w-[240px] flex-col gap-2 text-sm text-balance',
        className
      )}
      {...props}
    />
  );
}

function FeatureItemIcon({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="feature-item-icon"
      className={cn('flex items-center self-start', className)}
      {...props}
    />
  );
}

export { FeatureItem, FeatureItemDescription, FeatureItemIcon, FeatureItemTitle };
