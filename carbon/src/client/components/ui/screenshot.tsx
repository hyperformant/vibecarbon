import { cn } from '@/lib/utils';

interface ScreenshotProps {
  srcLight: string;
  srcDark?: string;
  alt: string;
  width: number;
  height: number;
  loading?: 'eager' | 'lazy';
  className?: string;
}

/**
 * Theme-aware screenshot. Adapted from Launch UI (MIT) for Vite: next/image is
 * swapped for a plain <img>, and the light/dark pair is toggled with Tailwind's
 * dark: variant instead of next/image's runtime.
 */
export default function Screenshot({
  srcLight,
  srcDark,
  alt,
  width,
  height,
  loading,
  className,
}: ScreenshotProps) {
  if (!srcDark) {
    return (
      <img
        src={srcLight}
        alt={alt}
        width={width}
        height={height}
        loading={loading}
        className={className}
      />
    );
  }
  return (
    <>
      <img
        src={srcLight}
        alt={alt}
        width={width}
        height={height}
        loading={loading}
        className={cn(className, 'block dark:hidden')}
      />
      <img
        src={srcDark}
        alt={alt}
        width={width}
        height={height}
        loading={loading}
        className={cn(className, 'hidden dark:block')}
      />
    </>
  );
}
