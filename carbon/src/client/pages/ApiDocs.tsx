import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';
import './api-docs.css';
import { Nav } from '@/components/Nav';
import { SEO } from '@/components/SEO';

export default function ApiDocs() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <SEO title="API Reference" description="Interactive API documentation" />

      <div className="scalar-wrapper pt-20 mx-auto max-w-7xl px-6">
        <ApiReferenceReact
          configuration={{
            url: '/api/openapi.json',
            darkMode: true,
            hideDownloadButton: true,
            customCss: `
              /* Map app theme to Scalar CSS variables */
              .dark-mode {
                --scalar-font: 'Noto Sans Variable', 'Noto Sans', system-ui, sans-serif;
                --scalar-font-code: 'JetBrains Mono', ui-monospace, monospace;

                /* Text colors */
                --scalar-color-1: oklch(0.98 0 0);
                --scalar-color-2: oklch(0.707 0.022 261.325);
                --scalar-color-3: oklch(0.55 0.02 261);
                --scalar-color-accent: oklch(0.82 0.14 192);

                /* Backgrounds — transparent so the app background shows through */
                --scalar-background-1: transparent;
                --scalar-background-2: oklch(0.18 0.025 258 / 0.5);
                --scalar-background-3: oklch(0.22 0.03 255 / 0.5);
                --scalar-background-accent: oklch(0.82 0.14 192 / 0.08);

                /* Border */
                --scalar-border-color: oklch(0.33 0.025 195 / 0.6);

                /* Radius — match app's --radius system */
                --scalar-radius: var(--radius);
                --scalar-radius-lg: var(--radius-xl);

                /* Sidebar */
                --scalar-sidebar-background-1: transparent;
                --scalar-sidebar-border-color: transparent;
                --scalar-sidebar-color-1: oklch(0.98 0 0);
                --scalar-sidebar-color-2: oklch(0.707 0.022 261.325);
                --scalar-sidebar-color-active: oklch(0.82 0.14 192);
                --scalar-sidebar-item-hover-background: oklch(0.18 0.025 258);
                --scalar-sidebar-item-active-background: oklch(0.22 0.03 255);
                --scalar-sidebar-search-background: oklch(0.18 0.025 258);
                --scalar-sidebar-search-border-color: oklch(0.33 0.025 195 / 0.4);
                --scalar-sidebar-search-color: oklch(0.707 0.022 261.325);
              }

              .light-mode {
                --scalar-font: 'Noto Sans Variable', 'Noto Sans', system-ui, sans-serif;
                --scalar-font-code: 'JetBrains Mono', ui-monospace, monospace;
                --scalar-color-accent: oklch(0.55 0.12 192);
                --scalar-radius: var(--radius);
                --scalar-radius-lg: var(--radius-xl);
              }

              /* Layout variables */
              .scalar-api-reference {
                --scalar-custom-header-height: 5rem;
                --scalar-sidebar-width: 14rem;
              }
            `,
          }}
        />
      </div>
    </div>
  );
}
