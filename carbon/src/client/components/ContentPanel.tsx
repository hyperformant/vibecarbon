import { cn } from '@/lib/utils';

/**
 * Layout variants for common page types:
 * - `narrow`: Settings, forms, profile pages (max-w-2xl)
 * - `default`: General content, lists (max-w-4xl)
 * - `wide`: Dashboards, multi-column layouts (max-w-6xl)
 * - `full`: Data tables that need horizontal space (max-w-full)
 */
export type LayoutVariant = 'narrow' | 'default' | 'wide' | 'full';

type MaxWidth = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | '6xl' | 'full';

interface ContentPanelProps {
  children: React.ReactNode;
  className?: string;
  /**
   * Semantic layout variant. Use this for standard layouts:
   * - `narrow`: Settings, forms, profile pages
   * - `default`: General content, lists
   * - `wide`: Dashboards, multi-column layouts
   * - `full`: Data tables that need horizontal space
   */
  variant?: LayoutVariant;
  /**
   * Custom max-width override. Only use when variant doesn't fit your needs.
   * Prefer using `variant` for consistency across the app.
   */
  maxWidth?: MaxWidth;
}

export const variantToWidth: Record<LayoutVariant, MaxWidth> = {
  narrow: '2xl',
  default: '4xl',
  wide: '6xl',
  full: 'full',
};

export const maxWidthClasses: Record<MaxWidth, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
  '6xl': 'max-w-6xl',
  full: 'max-w-full',
};

export function ContentPanel({
  children,
  className,
  variant = 'default',
  maxWidth,
}: ContentPanelProps) {
  // maxWidth takes precedence over variant for backwards compatibility
  const resolvedWidth = maxWidth ?? variantToWidth[variant];

  return (
    <div className="flex-1 pr-8 py-6">
      <div className={cn(maxWidthClasses[resolvedWidth], 'space-y-6', className)}>{children}</div>
    </div>
  );
}
