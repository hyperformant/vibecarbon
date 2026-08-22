// Default values mirroring index.css
export const DEFAULT_THEME = {
  light: {
    gradientStart: 'oklch(0.985 0.005 220)',
    gradientEnd: 'oklch(0.945 0.014 215)',
    card: 'oklch(0.995 0.004 210 / 0.92)',
    primary: 'oklch(0.52 0.124 192)',
    primaryDim: 'oklch(0.42 0.1 192)',
    primaryForeground: 'oklch(0.99 0.005 192)',
    secondaryAccent: 'oklch(0.47 0.2 350)',
    secondaryAccentForeground: 'oklch(0.99 0 0)',
    destructive: 'oklch(0.5 0.21 3.958)',
    warning: 'oklch(0.62 0.13 75)',
    success: 'oklch(0.5 0.12 181)',
  },
  dark: {
    gradientStart: 'oklch(0.105 0.018 252)',
    gradientEnd: 'oklch(0.145 0.028 228)',
    card: 'oklch(0.19 0.024 242 / 0.78)',
    primary: 'oklch(0.82 0.14 192)',
    primaryDim: 'oklch(0.65 0.12 192)',
    primaryForeground: 'oklch(0.1 0.02 220)',
    secondaryAccent: 'oklch(0.65 0.26 350)',
    secondaryAccentForeground: 'oklch(0.99 0 0)',
  },
  radius: '0.625rem',
  smoothScrollEnabled: true,
  smoothScrollIntensity: 60,
};

export type ThemeConfig = typeof DEFAULT_THEME;

type SlotKey =
  | 'gradientStart'
  | 'gradientEnd'
  | 'card'
  | 'primary'
  | 'primaryDim'
  | 'primaryForeground'
  | 'secondaryAccent'
  | 'secondaryAccentForeground'
  | 'destructive'
  | 'warning'
  | 'success';

const slotToCssVar: Record<SlotKey, string> = {
  gradientStart: '--gradient-start',
  gradientEnd: '--gradient-end',
  card: '--card',
  primary: '--primary',
  primaryDim: '--primary-dim',
  primaryForeground: '--primary-foreground',
  secondaryAccent: '--secondary-accent',
  secondaryAccentForeground: '--secondary-accent-foreground',
  destructive: '--destructive',
  warning: '--warning',
  success: '--success',
};

function buildCssBlock(
  selector: string,
  slots: Partial<Record<SlotKey, string>>,
  radius?: string
): string {
  const declarations: string[] = [];
  for (const [key, value] of Object.entries(slots)) {
    const cssVar = slotToCssVar[key as SlotKey];
    if (cssVar && value) {
      declarations.push(`  ${cssVar}: ${value};`);
    }
  }
  if (radius) {
    declarations.push(`  --radius: ${radius};`);
  }
  if (declarations.length === 0) return '';
  return `${selector} {\n${declarations.join('\n')}\n}`;
}

/**
 * Apply theme overrides by injecting/updating a <style> element in <head>.
 * Merges the provided partial theme over DEFAULT_THEME before applying.
 */
export function applyTheme(theme: Partial<ThemeConfig>): void {
  const light = { ...DEFAULT_THEME.light, ...theme.light };
  const dark = { ...DEFAULT_THEME.dark, ...theme.dark };
  const radius = theme.radius ?? DEFAULT_THEME.radius;

  const rootBlock = buildCssBlock(':root', light, radius);
  const darkBlock = buildCssBlock('.dark', dark);

  const css = [rootBlock, darkBlock].filter(Boolean).join('\n');

  let styleEl = document.getElementById('app-theme-overrides') as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'app-theme-overrides';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css;

  // Notify SmoothScroll component of scroll settings changes
  document.dispatchEvent(
    new CustomEvent('theme:scroll-settings', {
      detail: {
        enabled: theme.smoothScrollEnabled ?? DEFAULT_THEME.smoothScrollEnabled,
        intensity: theme.smoothScrollIntensity ?? DEFAULT_THEME.smoothScrollIntensity,
      },
    })
  );
}

/**
 * Reset theme to defaults by applying DEFAULT_THEME.
 */
export function resetTheme(): void {
  applyTheme(DEFAULT_THEME);
}
