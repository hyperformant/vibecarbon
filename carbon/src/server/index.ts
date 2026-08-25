import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { logger as honoLogger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { timeout } from 'hono/timeout';
import { isApiDocsEnabled } from './lib/docs-settings';
import { env } from './lib/env';
import { decodeAalFromJwt } from './lib/jwt';
import { logger } from './lib/logger';
import { createRateLimiter } from './lib/rate-limiter';
import { createSeoShell } from './lib/seo';
import { getSupabaseClient } from './lib/supabase';
import { servicesStatusRoutes } from './routes/_internal/services-status';
import { verifyRoleRoutes } from './routes/_internal/verify-role';
import { healthRoutes } from './routes/health';
import { v1Routes } from './routes/v1';
import { adminContactRoutes } from './routes/v1/admin/contact';
import { jobsRoutes } from './routes/v1/admin/jobs';
import { adminNewsletterRoutes } from './routes/v1/admin/newsletter';
import { authRoutes } from './routes/v1/auth';
import { billingRoutes } from './routes/v1/billing';
import { contactRoutes } from './routes/v1/contact';
import { newsletterRoutes } from './routes/v1/newsletter';
import { performanceRoutes } from './routes/v1/performance';
import { statsRoutes } from './routes/v1/stats';
import { themeRoutes } from './routes/v1/theme';
import { billingWebhookRoutes } from './routes/webhooks/billing';
import { stripeWebhookRoutes } from './routes/webhooks/stripe';
import type { HonoVariables } from './types';

const app = new Hono<{ Variables: HonoVariables }>();

// ============================================================================
// SECURITY MIDDLEWARE
// ============================================================================

// Analytics (Plausible) CSP allowance. `configure analytics` sets
// VITE_PLAUSIBLE_* in .env; the injected tag (see client index.html) can
// only load its script and POST /api/event if the CSP allows that origin.
// Derived from the configured script URL so Plausible Cloud and
// self-hosted instances both work — and gated on the same env that gates
// the tag, so an unconfigured project opens nothing. Without this the tag
// renders and every pageview is silently blocked (vibecarbon.com,
// 2026-08-23: 0 visitors under a perfectly rendered tag).
const plausibleOrigin = (() => {
  if (!process.env.VITE_PLAUSIBLE_DOMAIN) return null;
  try {
    return new URL(process.env.VITE_PLAUSIBLE_SCRIPT_URL || 'https://plausible.io/js/script.js')
      .origin;
  } catch {
    return null;
  }
})();

// Security headers (X-Content-Type-Options, X-Frame-Options, etc.)
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy:
      process.env.NODE_ENV === 'production'
        ? {
            defaultSrc: ["'self'"],
            scriptSrc: [
              "'self'",
              "'unsafe-inline'",
              'https://static.cloudflareinsights.com',
              ...(plausibleOrigin ? [plausibleOrigin] : []),
            ],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: [
              "'self'",
              // Production serves ONE origin: the SPA, the Hono API, and the
              // Supabase gateway (path-routed to Kong) all live on SITE_URL,
              // so 'self' + SITE_URL covers every first-party call. Fall back
              // to SUPABASE_URL for prod-like environments without SITE_URL.
              env.SITE_URL ?? env.SUPABASE_URL,
              'https://cloudflareinsights.com',
              'https://api.github.com',
              plausibleOrigin,
            ].filter(Boolean) as string[],
            fontSrc: ["'self'", 'data:'],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
          }
        : undefined,
    // HSTS: Force HTTPS for 1 year, include subdomains (production only)
    strictTransportSecurity:
      process.env.NODE_ENV === 'production' ? 'max-age=31536000; includeSubDomains' : false,
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'strict-origin-when-cross-origin',
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: 'same-origin',
  })
);

// Request timeout (30 seconds)
app.use('*', timeout(30000));

// Request logging
app.use('*', honoLogger());

// Rate limiting for API routes (100 requests per minute per IP)
app.use('/api/v1/*', createRateLimiter({ windowMs: 60 * 1000, max: 100 }));
// Both the exact liveness path AND the sub-paths: `/api/health` is an EXACT
// Hono match, so a bare `/api/health` rule would leave `/api/health/ready`
// (which does a DB round-trip) unlimited — an unauthenticated DB-amplification
// vector. Cover the bare path and the glob.
app.use('/api/health', createRateLimiter({ windowMs: 60 * 1000, max: 100 }));
app.use('/api/health/*', createRateLimiter({ windowMs: 60 * 1000, max: 100 }));

// Rate limiting for internal endpoints (higher threshold for infrastructure)
// These are called by Traefik for auth verification on each request
app.use('/api/_internal/*', createRateLimiter({ windowMs: 60 * 1000, max: 1000 }));

// Rate limiting for webhooks (higher threshold for external services)
// Stripe may send bursts of events (e.g., during subscription changes)
app.use('/api/webhooks/*', createRateLimiter({ windowMs: 60 * 1000, max: 500 }));

// CORS for SPA - restrict to allowed origins
app.use(
  '/api/*',
  cors({
    origin: (origin) => {
      // Build allowed origins list
      const allowedOrigins: string[] = [];

      // Always allow the configured site URL
      if (process.env.SITE_URL) {
        allowedOrigins.push(process.env.SITE_URL);
      }

      // Allow custom CORS origins from environment
      if (process.env.CORS_ORIGINS) {
        allowedOrigins.push(...process.env.CORS_ORIGINS.split(',').map((o) => o.trim()));
      }

      // Only allow localhost in development (with configurable ports)
      if (process.env.NODE_ENV !== 'production') {
        const portOffset = Number.parseInt(process.env.DEV_PORT_OFFSET || '0', 10);
        const vitePort = process.env.DEV_VITE_PORT || String(5173 + portOffset);
        const apiPort = process.env.DEV_API_PORT || String(3000 + portOffset);
        allowedOrigins.push(`http://localhost:${vitePort}`, `http://localhost:${apiPort}`);
      }

      return allowedOrigins.includes(origin) ? origin : null;
    },
    allowHeaders: ['Content-Type', 'Authorization', 'apikey'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    maxAge: 3600, // 1 hour
  })
);

// Request body size limit. bodyLimit enforces the cap while READING the stream,
// not just by trusting the Content-Length header (which a client can under-state
// or omit with chunked transfer-encoding to smuggle an oversized body past a
// header-only check).
app.use(
  '/api/*',
  bodyLimit({
    maxSize: 10 * 1024 * 1024, // 10MB
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  })
);

// Supabase session middleware - inject user and client into context
// Skip for health endpoint (no auth needed, avoids unnecessary getUser() call)
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health' || c.req.path === '/api/health/ready') {
    c.set('user', null);
    c.set('aal', null);
    await next();
    return;
  }

  const authHeader = c.req.header('Authorization');
  const supabase = getSupabaseClient(authHeader);
  c.set('supabase', supabase);

  // Verify the JWT and get user info
  if (authHeader?.startsWith('Bearer ')) {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (!error && user) {
      c.set('user', user);
      // Token signature already verified by getUser() above — safe to read claims.
      c.set('aal', decodeAalFromJwt(authHeader));
    } else {
      c.set('user', null);
      c.set('aal', null);
    }
  } else {
    c.set('user', null);
    c.set('aal', null);
  }

  await next();
});

// ============================================================================
// ROUTES
// ============================================================================

// Note: Auth is handled by Supabase (Kong routes to Auth service)
// Your Hono app only needs to handle application-specific APIs

// Health check (public, used by load balancers)
app.route('/api/health', healthRoutes);

// Internal endpoints (for infrastructure, e.g., Traefik ForwardAuth)
// Rate-limited at higher threshold (1000/min) to allow infrastructure calls
app.route('/api/_internal/verify-role', verifyRoleRoutes);
app.route('/api/_internal/services/status', servicesStatusRoutes);

// Versioned API endpoints (authenticated)
app.route('/api/v1', v1Routes);
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/billing', billingRoutes);
app.route('/api/v1/admin/theme', themeRoutes);
app.route('/api/v1/admin/stats', statsRoutes);
app.route('/api/v1/admin/performance', performanceRoutes);

app.route('/api/v1/admin/jobs', jobsRoutes);
app.route('/api/v1/admin/contact', adminContactRoutes);
app.route('/api/v1/admin/newsletter', adminNewsletterRoutes);
app.route('/api/v1/contact', contactRoutes);
app.route('/api/v1/newsletter', newsletterRoutes);

// Webhooks (no auth required, signature verified internally)
// Note: Must receive raw body for signature verification
app.route('/api/webhooks/billing', billingWebhookRoutes);
app.route('/api/webhooks/stripe', stripeWebhookRoutes); // Backward compat for existing Stripe deployments

// Backwards compatibility: redirect old /api/* to /api/v1/*
app.get('/api/me', (c) => c.redirect('/api/v1/me', 301));
app.get('/api/organizations', (c) => c.redirect('/api/v1/organizations', 301));
app.post('/api/organizations', (c) => c.redirect('/api/v1/organizations', 307));

// ============================================================================
// API DOCUMENTATION
// ============================================================================

// Calculate API port for OpenAPI spec
const portOffset = Number.parseInt(process.env.DEV_PORT_OFFSET || '0', 10);
const apiPort = process.env.DEV_API_PORT || String(3000 + portOffset);

// OpenAPI spec
const openApiSpec = {
  openapi: '3.0.0',
  info: {
    title: '{{PROJECT_DISPLAY_NAME}} API',
    version: '1.0.0',
    description: 'API documentation for {{PROJECT_DISPLAY_NAME}}',
  },
  servers: [{ url: `http://localhost:${apiPort}`, description: 'Development server' }],
  paths: {
    '/api/health': {
      get: {
        summary: 'Health check',
        tags: ['Health'],
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'healthy' },
                    timestamp: { type: 'string', format: 'date-time' },
                    services: {
                      type: 'object',
                      properties: {
                        database: { type: 'string' },
                        supabase: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/v1/me': {
      get: {
        summary: 'Get current user',
        tags: ['User'],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'User info with memberships and role' },
          '401': { description: 'Unauthorized' },
        },
      },
    },
    '/api/v1/organizations': {
      get: {
        summary: 'List organizations',
        tags: ['Organizations'],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'List of organizations' },
          '401': { description: 'Unauthorized' },
        },
      },
      post: {
        summary: 'Create organization',
        tags: ['Organizations'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'slug'],
                properties: {
                  name: { type: 'string' },
                  slug: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Organization created' },
          '400': { description: 'Bad request' },
          '401': { description: 'Unauthorized' },
        },
      },
    },
    '/api/v1/billing/checkout': {
      post: {
        summary: 'Create checkout session',
        tags: ['Billing'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['priceId', 'type'],
                properties: {
                  priceId: { type: 'string' },
                  type: { type: 'string', enum: ['user', 'organization'] },
                  organizationId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Checkout session URL' },
          '401': { description: 'Unauthorized' },
        },
      },
    },
    '/api/v1/contact/submit': {
      post: {
        summary: 'Submit contact form',
        description: 'Public endpoint, rate-limited (5 per 15 minutes). Honeypot spam protection.',
        tags: ['Contact'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'email', 'subject', 'message'],
                properties: {
                  name: { type: 'string', maxLength: 200 },
                  email: { type: 'string', format: 'email' },
                  subject: { type: 'string', maxLength: 300 },
                  message: { type: 'string', minLength: 10, maxLength: 5000 },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Submission received' },
          '400': { description: 'Validation error' },
          '429': { description: 'Rate limit exceeded' },
        },
      },
    },
    '/api/v1/newsletter/subscribe': {
      post: {
        summary: 'Subscribe to newsletter',
        description:
          'Public endpoint, rate-limited. Uses double opt-in (sends confirmation email).',
        tags: ['Newsletter'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  name: { type: 'string', maxLength: 200 },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Subscription initiated; check email to confirm' },
          '400': { description: 'Validation error' },
        },
      },
    },
    '/api/v1/admin/jobs': {
      get: {
        summary: 'List background jobs',
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Job summaries and execution history' },
          '403': { description: 'Forbidden: requires super admin' },
        },
      },
    },
    '/api/v1/admin/contact': {
      get: {
        summary: 'List contact submissions',
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Paginated contact submissions' },
          '403': { description: 'Forbidden: requires super admin' },
        },
      },
    },
    '/api/v1/admin/newsletter': {
      get: {
        summary: 'List newsletter subscribers',
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Paginated subscriber list' },
          '403': { description: 'Forbidden: requires super admin' },
        },
      },
    },
    '/api/webhooks/billing': {
      post: {
        summary: 'Billing webhook handler',
        description:
          'Provider-agnostic webhook endpoint. Detects Stripe/Paddle/Polar from active provider. Signature verified internally.',
        tags: ['Webhooks'],
        responses: {
          '200': { description: 'Webhook processed' },
          '400': { description: 'Invalid signature or payload' },
        },
      },
    },
    '/api/_internal/verify-role': {
      get: {
        summary: 'Verify user role (ForwardAuth)',
        description:
          'Internal endpoint for Traefik ForwardAuth. Verifies JWT and checks user role.',
        tags: ['Internal'],
        parameters: [
          {
            name: 'role',
            in: 'query',
            description: 'Required role (e.g., admin)',
            schema: { type: 'string' },
          },
          {
            name: 'roles',
            in: 'query',
            description: 'Comma-separated list of acceptable roles',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'User authenticated and has required role' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Authenticated but lacks required role' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
  },
};

// The API documentation surface (spec + both viewers) is gated on a runtime
// setting a super admin can flip, so the check has to happen per request
// rather than at mount time. isApiDocsEnabled() is cached and fails open.
const requireApiDocsEnabled = createMiddleware(async (c, next) => {
  if (!(await isApiDocsEnabled())) {
    return c.notFound();
  }
  await next();
});

// Serve OpenAPI spec under /api so Vite proxy works
app.get('/api/openapi.json', requireApiDocsEnabled, (c) => c.json(openApiSpec));

// API docs (dev-only dependencies, conditionally loaded)
if (process.env.NODE_ENV !== 'production') {
  const [{ apiReference }, { swaggerUI }] = await Promise.all([
    import('@scalar/hono-api-reference'),
    import('@hono/swagger-ui'),
  ]);
  app.get(
    '/api/docs',
    requireApiDocsEnabled,
    apiReference({
      url: '/api/openapi.json',
      pageTitle: '{{PROJECT_DISPLAY_NAME}} API',
      theme: 'purple',
    })
  );
  app.get('/api/swagger', requireApiDocsEnabled, swaggerUI({ url: '/api/openapi.json' }));
}

// ============================================================================
// STATIC FILE SERVING (Production) / API Docs redirect (Development)
// ============================================================================

if (process.env.NODE_ENV === 'production') {
  // Serve the SPA shell with per-route title/meta, JSON-LD, and content HTML
  // spliced in (built by scripts/generate-seo.ts) so crawlers that don't
  // execute JS see real content; hydration replaces it for browsers.
  const seoShell = createSeoShell();
  const serveSeoShell = (c: Context) => {
    const html = seoShell.render(c.req.path);
    if (html === null) return c.notFound();
    c.header('Cache-Control', 'no-cache');
    return c.html(html);
  };

  // Must come before the '/*' static middleware, whose directory-index
  // resolution would otherwise serve the raw index.html for '/'.
  app.get('/', serveSeoShell);

  // Static assets with cache headers
  app.use(
    '/assets/*',
    serveStatic({
      root: './dist/client',
      onFound: (_path, c) => {
        c.header('Cache-Control', 'public, immutable, max-age=31536000');
      },
    })
  );

  // Serve static files from dist/client. HTML (index.html for `/`) must NOT be
  // heuristically cached, or returning visitors keep loading a stale index that
  // references old hash-busted asset URLs after a deploy. `no-cache` still allows
  // 304 revalidation, so it's cheap — only the tiny HTML is re-checked.
  app.use(
    '/*',
    serveStatic({
      root: './dist/client',
      onFound: (path, c) => {
        if (path.endsWith('.html')) c.header('Cache-Control', 'no-cache');
        // hono's mime map has no `md` entry (falls through to octet-stream,
        // a download) — the llms.txt markdown mirrors should display as text.
        if (path.endsWith('.md')) c.header('Content-Type', 'text/markdown; charset=utf-8');
      },
    })
  );

  // SPA fallback - serve the (possibly SEO-injected) shell for client-side
  // routing (always revalidate).
  app.get('/*', serveSeoShell);
} else {
  // Development: redirect root to API docs (frontend served by Vite dev server).
  // With the API docs turned off there is nothing to redirect to, so say so
  // rather than bouncing the developer into a 404.
  app.get('/', async (c) => {
    if (!(await isApiDocsEnabled())) {
      return c.text('API documentation is disabled in admin settings.', 404);
    }
    return c.redirect('/api/docs');
  });
}

// ============================================================================
// SERVER STARTUP
// ============================================================================

const port = env.DEV_API_PORT ?? env.PORT + env.DEV_PORT_OFFSET;

// Login attempt cleanup is now handled by pg_cron (see migration 00003_pg_cron.sql)

logger.info({ port }, 'Starting server');

const server = serve({
  fetch: app.fetch,
  port,
});

// Graceful shutdown handler - drain in-flight requests before exiting
let isShuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 10000;

const shutdown = (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Shutting down gracefully...');

  // Stop accepting new connections and wait for in-flight requests to finish
  server.close(() => {
    logger.info('All connections closed');
    process.exit(0);
  });

  // Force exit if draining takes too long
  setTimeout(() => {
    logger.warn('Shutdown timeout reached, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
