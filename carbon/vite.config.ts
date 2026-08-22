import path from 'node:path';
import mdx from '@mdx-js/rollup';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeSlug from 'rehype-slug';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import { createLogger, defineConfig, loadEnv } from 'vite';
import { isViteUrlBannerLine } from './scripts/lib/vite-log-filter.js';

// Calculate ports based on offset and overrides
function getPort(envVarName: string, defaultPort: number, offset: number): number {
  const override = process.env[envVarName];
  if (override) return Number.parseInt(override, 10);
  return defaultPort + offset;
}

export default defineConfig(({ mode }) => {
  // Load env from project root (where .env.local lives)
  const env = loadEnv(mode, path.resolve(import.meta.dirname), '');

  const portOffset = Number.parseInt(env.DEV_PORT_OFFSET || '0', 10);
  const vitePort = getPort('DEV_VITE_PORT', 5173, portOffset);
  const apiPort = getPort('DEV_API_PORT', 3000, portOffset);
  const kongPort = getPort('DEV_KONG_PORT', 8000, portOffset);

  // Override client-side env vars with offset-adjusted ports in development.
  // VITE_SUPABASE_URL and SITE_URL are hardcoded to default ports in .env,
  // but DEV_PORT_OFFSET shifts Docker ports (Kong on 8000+offset).
  const devDefines: Record<string, string> =
    mode === 'development' && portOffset !== 0
      ? {
          'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(`http://localhost:${kongPort}`),
          'import.meta.env.SITE_URL': JSON.stringify(`http://localhost:${vitePort}`),
        }
      : {};

  const logger = createLogger();
  const baseInfo = logger.info.bind(logger);
  // Our dev.js banner is the single source of truth for service URLs; drop
  // Vite's redundant Local/Network/"press h" lines but keep readiness, HMR,
  // warnings, and errors.
  logger.info = (msg, options) => {
    if (isViteUrlBannerLine(msg)) return;
    baseInfo(msg, options);
  };

  return {
    customLogger: logger,

    plugins: [
      mdx({
        remarkPlugins: [remarkFrontmatter, remarkGfm, remarkMdxFrontmatter],
        rehypePlugins: [rehypeSlug, [rehypeAutolinkHeadings, { behavior: 'wrap' }]],
      }),
      react(),
      tailwindcss(),
    ],

    define: devDefines,

    root: 'src/client',
    envDir: '../..',

    build: {
      outDir: '../../dist/client',
      emptyOutDir: true,
      // Security: Explicitly disable source maps in production builds
      // Using mode check since NODE_ENV may not be set during Vite build
      sourcemap: mode === 'development',
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/react/') ||
              id.includes('node_modules/react-router')
            )
              return 'vendor-react';
            if (id.includes('node_modules/@supabase/')) return 'vendor-supabase';
            if (id.includes('node_modules/@tanstack/react-query')) return 'vendor-query';
            // DO NOT split recharts into its own chunk. With rolldown-vite (Vite 8 +
            // rolldown 1.x), splitting a CJS-React consumer causes rolldown to bundle
            // a *second* copy of React inside that chunk to satisfy the CJS interop
            // for `import * as React from 'react'`. The main entry then imports its
            // React namespace (X.lazy, X.useState) from the recharts chunk while
            // page chunks still import from vendor-react — two Reacts in one app.
            // React.lazy elements created by one and rendered by the other resolve
            // to {} and React throws minified #306 ("Lazy element type must resolve
            // to a class or function") on first render → ErrorBoundary catches →
            // white screen. Verified 2026-05-26 against rolldown 1.0.1 by patching
            // the deployed vendor-react and dumping the failing lazy's payload.
            // Leave recharts in the default chunk so React stays single-copy.
            // if (id.includes('node_modules/recharts')) return 'vendor-charts';
            if (id.includes('node_modules/framer-motion')) return 'vendor-motion';
            if (
              id.includes('node_modules/cmdk') ||
              id.includes('node_modules/vaul') ||
              id.includes('node_modules/sonner') ||
              id.includes('node_modules/embla-carousel-react')
            )
              return 'vendor-ui';
          },
        },
      },
    },

    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src/client'),
        '@shared': path.resolve(import.meta.dirname, './src/shared'),
        '@content': path.resolve(import.meta.dirname, './content'),
      },
    },

    server: {
      port: vitePort,
      // Listen on all interfaces so Docker containers can reach Vite via host.docker.internal
      // This enables accessing the app at http://app.localhost through Traefik
      host: true,
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
          // Let React Router handle /api/docs — don't proxy it to the backend
          bypass(req) {
            if (req.url === '/api/docs') return req.url;
          },
        },
      },
    },
  };
});
