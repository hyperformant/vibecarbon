import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
import logoDarkUrl from '../assets/logo-dark.svg';
import logoIconUrl from '../assets/logo-icon.svg';
import logoLightUrl from '../assets/logo-light.svg';
import logoWordmarkDarkUrl from '../assets/logo-wordmark-dark.svg';
import logoWordmarkLightUrl from '../assets/logo-wordmark-light.svg';

// Split across two lines so the formatted output is stable regardless of the
// rendered project-name length (biome wraps >100-char lines, which caused CI
// lint failures in e2e when the project slug was long).
const DEFAULT_PROJECT_NAME = '{{PROJECT_NAME}}';
export const PROJECT_NAME = import.meta.env.VITE_PROJECT_NAME ?? DEFAULT_PROJECT_NAME;

// Human-facing brand name. PROJECT_NAME stays the machine slug (container
// names, Grafana dashboard uids); this is what users see in titles, alt text,
// and legal copy.
const DEFAULT_PROJECT_DISPLAY_NAME = '{{PROJECT_DISPLAY_NAME}}';
export const PROJECT_DISPLAY_NAME =
  import.meta.env.VITE_PROJECT_DISPLAY_NAME ?? DEFAULT_PROJECT_DISPLAY_NAME;

// To rebrand, replace the SVGs in src/client/assets/ with your own, keeping the
// filenames: logo-icon.svg is the standalone mark; logo-{light,dark}.svg the
// full lockup; logo-wordmark-{light,dark}.svg the wordmark alone.
// PROJECT_DISPLAY_NAME supplies the images' alt text. The browser-tab favicon
// is a separate swap — replace src/client/public/favicon.svg.

interface LogoProps {
  size?: 'sm' | 'default' | 'lg';
  className?: string;
}

// `w-auto` derives width from each asset's intrinsic aspect ratio instead of a
// hand-computed guess.
const sizeClasses = {
  sm: 'h-6 w-auto',
  default: 'h-8 w-auto',
  lg: 'h-10 w-auto',
};

/** Standalone logo mark (theme-agnostic). */
export function Logo({ size = 'default', className }: LogoProps) {
  return (
    <img
      src={logoIconUrl}
      alt=""
      aria-hidden="true"
      className={cn('shrink-0', sizeClasses[size], className)}
    />
  );
}

interface WordmarkTextProps {
  size?: 'sm' | 'default' | 'lg';
  className?: string;
  /** Overrides theme-based asset selection. */
  forceTheme?: 'light' | 'dark';
}

/**
 * Wordmark-only half of the logo, exported at the same height as <Logo> for
 * each size tier so the two compose edge-to-edge with a plain gap — no
 * fused-image or margin tuning needed. Pair with a standalone <Logo> for a
 * collapsible sidebar header: the icon stays a single, never-swapped element
 * (the standard collapse pattern — see shadcn/ui's TeamSwitcher), and only this
 * wordmark piece toggles visibility via `group-data-[collapsible=icon]`.
 */
export function WordmarkText({ size = 'default', className, forceTheme }: WordmarkTextProps) {
  const { resolvedTheme } = useTheme();
  const theme = forceTheme ?? resolvedTheme;
  const src = theme === 'light' ? logoWordmarkLightUrl : logoWordmarkDarkUrl;
  return (
    <img
      src={src}
      alt={PROJECT_DISPLAY_NAME}
      className={cn('shrink-0', sizeClasses[size], className)}
    />
  );
}

/**
 * Full logo lockup (mark + wordmark).
 * Sizes: sm (footers), default (nav/sidebar), lg (auth hero pages).
 * Wrap in a <Link> with className="group" for hover effects.
 */
interface WordmarkProps {
  size?: 'sm' | 'default' | 'lg';
  className?: string;
  forceTheme?: 'light' | 'dark';
}

export function Wordmark({ size = 'default', className, forceTheme }: WordmarkProps) {
  const { resolvedTheme } = useTheme();
  const theme = forceTheme ?? resolvedTheme;
  const src = theme === 'light' ? logoLightUrl : logoDarkUrl;
  return (
    <img
      src={src}
      alt={PROJECT_DISPLAY_NAME}
      className={cn('shrink-0', sizeClasses[size], className)}
    />
  );
}
