import { useEffect } from 'react';
import { PROJECT_DISPLAY_NAME } from '@/components/Logo';

interface SEOProps {
  title?: string;
  /** Exact document title, used verbatim without the `| PROJECT_DISPLAY_NAME` suffix. */
  fullTitle?: string;
  description?: string;
}

/**
 * Lightweight SEO component that updates document title and meta description.
 *
 * Usage:
 *   <SEO title="Pricing" description="See our plans" />
 *   <SEO title="Dashboard" />
 *   <SEO fullTitle="Acme - The Best Widget" />
 */
export function SEO({ title, fullTitle, description }: SEOProps) {
  useEffect(() => {
    document.title =
      fullTitle ?? (title ? `${title} | ${PROJECT_DISPLAY_NAME}` : PROJECT_DISPLAY_NAME);
  }, [title, fullTitle]);

  useEffect(() => {
    if (!description) return;
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', description);
  }, [description]);

  return null;
}
