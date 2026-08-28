# Features

## Authentication

- Email/password sign-in and sign-up
- Minimum password length enforced (8 characters)
- Email normalized to lowercase on all auth operations
- Sign in with Google (configurable via `GOOGLE_ENABLED`)
- Sign in with Microsoft/Azure AD (configurable via `MICROSOFT_ENABLED`)
- Sign in with GitHub (configurable via `GITHUB_ENABLED`)
- Sign in with Apple (configurable via `APPLE_ENABLED`)
- Sign in with Discord (configurable via `DISCORD_ENABLED`)
- OAuth providers rendered dynamically based on which are enabled
- Magic link / passwordless email sign-in (configurable via `MAGIC_LINK_ENABLED`, default on)
- Multi-factor authentication (TOTP)
  - QR code enrollment with manual secret fallback
  - 6-digit OTP auto-submit input
  - Per-user factor management (add/remove authenticators)
  - Global MFA enforcement toggle (super admin)
  - Redirects unenrolled users to setup when MFA is required
- Account lockout after 5 failed attempts (15-minute window, per email+IP)
  - Admin manual unlock capability
  - Automatic cleanup of old attempts (every 6 hours, 24-hour retention)
- Password reset via email with anti-enumeration (always shows success)
- JWT-based sessions with 1-hour access tokens and automatic refresh
- Cookie-based token storage (`SameSite=Lax`, 7-day max-age, cross-subdomain support)
- Session validated server-side on mount (detects stale tokens after DB reset)
- OAuth callback route (`/auth/callback`) with session handoff
- Anonymous users explicitly disabled
- Open redirect protection on login redirects (blocks `//`, `:` schemes)

## User Impersonation

- Super admin can impersonate any non-super-admin user
- Admin session preserved and restored on stop
- Prominent amber banner displayed during impersonation with target email
- Server-side audit logging of impersonation events
- Cannot impersonate self or other super admins

## Billing & Payments

- **Multi-provider support**: Stripe (default), Paddle, and Polar via `BILLING_PROVIDER` env var
  - `BillingProvider` interface with factory pattern (`getBillingProvider()`)
  - Provider-agnostic billing routes, with the same API contracts regardless of provider
  - Normalized webhook events across all providers
  - Config-driven price ID mapping per provider (`STRIPE_PRICE_*`, `PADDLE_PRICE_*`, `POLAR_PRICE_*`)
- Stripe integration (optional, gracefully disabled when unconfigured)
- Paddle integration via Paddle API v2 (sandbox and production environments)
- Polar integration via Polar API (developer/AI-focused billing)
- Three plan tiers: Starter ($0), Pro ($29/mo), Team ($99/mo)
- Per-plan feature lists and API rate limits (60 / 200 / 1000 req/min)
- Provider checkout for subscription creation
- Customer portal for self-service billing management (Stripe, Paddle, Polar)
- Generic webhook handler at `/api/webhooks/billing` with provider-specific signature verification
  - Stripe: `stripe-signature` header with HMAC
  - Paddle: `paddle-signature` header with `ts=...;h1=...` HMAC-SHA256
  - Polar: `webhook-id` + `webhook-timestamp` + `webhook-signature` headers with HMAC-SHA256
  - Backward-compatible Stripe webhook at `/api/webhooks/stripe`
- Normalized webhook events: `checkout.completed`, `subscription.created/updated/deleted`, `payment.failed`
- Lazy customer provisioning (created on first checkout, with rollback on failure)
- User and organization billing (separate customer records per type)
- In-process Stripe price cache (1-hour TTL)
- Server-side plan gating middleware (`requirePlan('starter' | 'pro')`)
  - Plan hierarchy enforcement: free < starter < pro
  - Bypassed when billing is not configured (dev/self-hosted mode)
- Client-side `<PlanGate>` component with fallback UI
- Subscription hook with active/trialing/canceling states
- Pricing page with responsive 3-column card layout and "Most Popular" badge
- Account deletion cancels all active subscriptions before removing user

## Organizations & Multi-Tenancy

- Create, rename, and delete organizations
- URL-safe slug (unique, immutable after creation)
- Three membership roles: Owner, Admin, Member
- Role-based permissions enforced at both API and RLS levels
  - Owner: full control, transfer ownership, delete org
  - Admin: manage members (add/remove/promote), update org
  - Member: read-only access to org data
- Add members by email (must have an existing account)
- Ownership transfer (auto-demotes previous owner to Admin)
- Self-leave with sole-owner guard (must transfer ownership first)
- Cannot delete last organization
- Organization invite email sent on member add
- Organization switcher in sidebar with per-org settings link
- Selected organization persisted in localStorage across sessions
- Organization-scoped billing (separate Stripe customer per org)
- RLS-enforced data isolation across organizations
- Admin panel: view all organizations across tenants with search, sort, and pagination

## Email (Transactional)

- Nodemailer SMTP transport (bring-your-own SMTP server)
- Shares SMTP credentials with Supabase Auth (single mail config)
- Gracefully no-ops when SMTP is not configured (emails logged as skipped)
- HTML injection protection via `escapeHtml()` on all user-supplied fields
- Three email templates:
  - Organization invite (inviter name, org name, role, CTA to login)
  - Subscription confirmed (plan name, amount, billing interval)
  - Payment failed (plan name, CTA to update payment method)
- Responsive HTML layout (inlined CSS, 560px max-width, dark-mode safe)
- All transactional emails sent fire-and-forget (never block HTTP responses)

## File Uploads & Storage

- Supabase Storage backend (self-hosted, no third-party CDN required)
- Direct client-to-Supabase upload (not proxied through API server)
- Generic `<FileUpload>` component
  - Configurable bucket, path prefix, accepted file types, and max size
  - Drag-and-drop zone with visual feedback
  - Click-to-browse fallback
  - Loading spinner during upload
  - Client-side file size validation (default 10 MB)
  - Upsert mode (re-upload overwrites)
- `<AvatarUpload>` specialization
  - Hardcoded to `avatars` bucket
  - Accepts JPEG, PNG, GIF, WebP (max 2 MB)
  - Circular preview with placeholder
  - Persists URL to user metadata on upload
- Storage RLS: user-scoped paths (`auth.uid()` as first path segment)
- Avatars bucket: public read, private write
- Uploads bucket: fully private

## Contact Form

- Built-in contact form at `/contact` with public submission API
- `POST /api/v1/contact/submit`, rate-limited (5 per 15 minutes per IP), Zod validated
- Honeypot spam prevention (hidden `website` field catches bots silently)
- Submissions stored in `contact_submissions` table (id, name, email, subject, message, status)
- Status workflow: unread → read → replied → archived
- Admin email notification on new submission (via SMTP, non-blocking)
- Admin panel at `/admin/contact` with submission list, detail dialog, and status management
- Reply via email link and mark-as-replied from admin UI
- Delete and archive actions
- RLS: public can insert, only super admins can read/manage

## Newsletter

- Built-in newsletter subscriber management with double opt-in
- `NewsletterSignup` component (inline or stacked variant, embeddable anywhere)
- Embedded on homepage CTA footer ("Stay up to date" section)
- `POST /api/v1/newsletter/subscribe`, rate-limited (10 per 15 minutes per IP)
- Double opt-in: confirmation email with unique token, `/api/v1/newsletter/confirm?token=...`
- One-click unsubscribe: `/api/v1/newsletter/unsubscribe?email=...&token=...`
- Unsubscribe link automatically appended to every sent newsletter
- `newsletter_subscribers` table (email unique, status: pending/active/unsubscribed)
- Anti-enumeration: identical response for existing/new emails
- Admin panel at `/admin/newsletter`:
  - Subscriber stats (total, active, pending, unsubscribed)
  - Searchable subscriber list with status badges
  - Compose and send newsletter to all active subscribers
  - CSV export of active subscribers
  - Per-subscriber delete
- RLS: public can insert/update (for confirm/unsubscribe), only super admins can read/manage

## Content (MDX)

- Three content sections: Blog, Changelog, Docs
- MDX compiled via `@mdx-js/rollup` with Vite
- Remark plugins: frontmatter parsing, GFM (tables, strikethrough, task lists)
- Rehype plugins: auto-generated heading IDs, heading anchor links
- Content auto-discovered via `import.meta.glob` (no manual registration)
- Blog
  - Card grid index page with title, description, date, author
  - Full article page with Tailwind Typography (`prose`) styling
  - Sorted by date (newest first)
- Changelog
  - Same card grid layout as blog
  - Optional semver version badge per entry
- Docs
  - Sidebar navigation with order-based sorting
  - Client-side full-text search with `Cmd+K` / `Ctrl+K` keyboard shortcut
  - Search results dropdown with title and snippet
  - Mobile sidebar with overlay and backdrop blur
  - Previous/Next page navigation
  - Package manager switcher (npm/pnpm/bun) persisted in localStorage
  - Live code block substitution for package manager commands
- Legal pages: Privacy Policy (`/privacy`) and Terms of Service (`/terms`)
  - MDX content with `{{PROJECT_NAME}}` and `{{ADMIN_EMAIL}}` placeholders
  - Standalone routes with dedicated footer
  - Links in homepage and docs footers
- Hot reload on MDX content changes via Vite HMR

## Internationalization (i18n)

- i18next with `react-i18next` and browser language detector
- Language auto-detected from browser locale, persisted in localStorage
- Fallback language: English
- English locale file shipped with 11 namespaces: common, nav, sidebar, createOrg, auth, dashboard, profile, billing, security, onboarding, admin
- Interpolation support (email, plan name, dates, counts)
- All interactive pages and components use `useTranslation()` hook
- **Language switcher** component (`LanguageSwitcher.tsx`) in navbar
  - Hidden when only one language is configured
  - Selection persisted to localStorage via i18next's LanguageDetector
  - Renders in both desktop and mobile nav
- Ships English-only by default: the locale JSON files under `carbon/src/client/locales/` are the language configuration, globbed at build time (no env var)
- Languages are added or removed with `vibecarbon configure globalization`, from the supported picker set: en, es, fr, de, pt
- Not yet translated: server-side error messages, email templates, MDX content, landing page marketing copy

## Background Jobs (pg_cron)

- Scheduled background jobs via PostgreSQL's built-in `pg_cron` extension
- Zero additional infrastructure: no Redis, no worker process, no external queue
- Three default jobs:
  - `cleanup-login-attempts`: every 6 hours, removes attempts older than 24 hours
  - `cleanup-expired-notifications`: daily at 3 AM, deletes past-expiry notifications
  - `cleanup-job-history`: weekly (Sunday 4 AM), prunes history older than 30 days
- `cron_job_history` table for execution tracking (job name, status, result, error, timestamps)
- `log_cron_job()` helper function for logging results from custom jobs
- Admin panel at `/admin/jobs`:
  - View all scheduled jobs with last run status and result
  - Execution history (last 50 runs)
  - "Run Now" button to manually trigger any job
- API endpoints (super admin only):
  - `GET /api/v1/admin/jobs` lists jobs and recent history
  - `GET /api/v1/admin/jobs/history` returns detailed execution history with filtering
  - `POST /api/v1/admin/jobs/trigger` manually triggers a job (allowlisted names only)
- Replaced previous hardcoded `setInterval` cleanup in `server/index.ts`
- RLS: only super admins can read job history

## Product Analytics (Plausible)

- Built-in support for Plausible Analytics (privacy-friendly, cookie-free)
- Conditional script injection in HTML `<head>`, with zero overhead when unconfigured
- Environment variables: `VITE_PLAUSIBLE_DOMAIN`, `VITE_PLAUSIBLE_SCRIPT_URL`
- Works with Plausible Cloud or self-hosted Plausible
- No cookies and no cross-site tracking, so nothing to put behind a consent banner
- Under 1KB script, no impact on page speed
- Documentation page at `/docs/analytics`

## Admin Panel

- Super admin role (`app_metadata.role = 'super_admin'`)
- Route guard redirects non-admins to dashboard
- Admin Dashboard
  - Service health overview
  - Security settings (MFA enforcement toggle)
  - Documentation visibility settings (User Docs `/docs` route, API Docs `/api/docs` + `/api/openapi.json`, server-enforced, both default on)
  - Locked accounts list with manual unlock
- User Management
  - Paginated, searchable, sortable user list
  - Name, email, role badge, verification status, org count, last sign-in, join date
  - One-click impersonation from user list
- Organization Management
  - Paginated, searchable, sortable org list
  - Name, slug, plan tier (color-coded badge), member count, created date
- Infrastructure Dashboard
  - Visual service topology map (Edge, Gateway, Application, Data, Observability, Tooling layers)
  - Per-service health status and latency
  - Summary badges (healthy/unhealthy/total counts)
  - Auto-refresh every 30 seconds
  - Deployment info: environment, version, Supabase URL, HA mode
- Docker Log Viewer
  - Filter by container, time range (5m to 24h), line count (100 to 1000)
  - Color-coded log severity (error/warning/debug)
  - Auto-scroll toggle and manual refresh
  - Auto-refresh every 10 seconds
  - Link to Grafana Logs dashboard when observability is enabled
- Notification Management
  - Create, edit, delete, and toggle notifications
  - Full CRUD with inline active toggle
- Background Jobs Dashboard (`/admin/jobs`)
  - View scheduled jobs, execution history, and manual triggers
- Contact Submissions (`/admin/contact`)
  - View, read, reply, archive, and delete contact form submissions
- Newsletter Management (`/admin/newsletter`)
  - Subscriber stats, searchable list, compose & send, CSV export

## Notifications

- Database-backed notification system
- Four severity types: info (blue), success (green), warning (amber), error (red)
- Three visibility levels: all, authenticated-only, public-only
- Scheduling via `starts_at` / `ends_at` timestamps (enforced at RLS level)
- Organization-scoped notifications (shown only to org members)
- Optional action button with URL (opens in new tab)
- Dismissible toggle per notification
  - Per-user dismissal state persisted server-side
  - Non-dismissible notifications cannot be dismissed (validated server-side)
- Top-of-page sticky notification bar with expandable drawer for multiple notifications
- Created/managed exclusively by super admins
- RLS policies enforce visibility rules for authenticated and anonymous users

## Security

- Content Security Policy (production): strict `default-src`, `script-src`, `connect-src`, `object-src: 'none'`, `frame-ancestors: 'none'`
- Security headers: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Resource-Policy: same-origin`
- HSTS in production (1 year, includeSubDomains)
- CORS strict origin allowlist with credentials support
- Rate limiting (three tiers: 100/500/1000 req/min by route prefix)
  - Hybrid store: Redis (distributed) with automatic in-memory fallback
  - Rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
  - IP extraction: `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`
- Request body size limit (10 MB, returns 413)
- Request timeout (30 seconds globally)
- Zod validation on all request bodies and query parameters
  - Pagination search input validated against safe character regex
- Error sanitization in production (generic messages to client, full details logged server-side)
- Row Level Security (RLS) enabled on all tables
  - All policies use `(SELECT auth.uid())` subquery form to prevent per-row re-evaluation
  - `SECURITY DEFINER` + `SET search_path = ''` on all helper functions
- Privilege separation: user-context Supabase client for user queries, admin client only where required
- Disposable auth client for `signInWithPassword` (prevents session state contamination)
- Billing webhook signature verification before processing (Stripe HMAC, Paddle HMAC-SHA256, Polar HMAC-SHA256 with timing-safe comparison)
- Traefik ForwardAuth for infrastructure services (Studio, Grafana)
  - Role-based access: `super-admin-auth` middleware requires `super_admin` role to access all admin services
  - Validated redirect URLs (protocol allowlist prevents open redirects)
- Kong API gateway with key-auth plugin on all Supabase services
- Super admin deletion protection (must remove role first)
- Environment variable validation at startup (exits on failure, hides specifics in production)
- Service role key never exposed to client
- Kubernetes pod security: non-root user, read-only root filesystem, no capabilities, no privilege escalation
- Deny-all NetworkPolicy as default in Kubernetes
- Operator-IP firewall lock. SSH (port 22) and Kubernetes API (port 6443) are restricted to a project-level CIDR allowlist; auto-detected on first run, manageable via `vibecarbon access`

## API

- Hono 4 framework on `@hono/node-server`
- Type-safe context injection (user, Supabase client per request)
- Middleware stack: secure headers, timeout, logging, rate limiting, CORS, body size limit, auth JWT extraction
- Structured logging via Pino (info in production, debug in development with pretty-printing)
- OpenAPI 3.0 spec at `/api/openapi.json`
- Scalar API Reference at `/api/docs` (dev only)
- Swagger UI at `/api/swagger` (dev only)
- Health check endpoints: `/api/health` (liveness probe, no DB check) and `/api/health/ready` (readiness probe, checks DB connectivity)
- Admin API endpoints: `GET /api/v1/admin/stats` (super admin stats), `GET /api/v1/admin/performance` (service performance/health checks)
- Versioned routes (`/api/v1/*`) with 301 redirects from legacy paths
- Plan gating middleware for paid-tier features
- Graceful shutdown on SIGINT/SIGTERM (10-second drain timeout)
- Periodic maintenance via pg_cron (login attempt cleanup, notification cleanup, job history pruning)

## UI Components (60)

- Built on Shadcn UI patterns with Radix UI, Base UI, and CVA for variants
- Styled with Tailwind CSS v4
- **Forms (13):** Button (7 variants, 8 sizes, SparkBurst effect), Input, Textarea, Checkbox, RadioGroup, Switch, Select, Slider, InputOTP, Calendar, Label, Field system (inline/horizontal/responsive), InputGroup (addons, icons, buttons)
- **Data Display (5):** Table, Chart (Recharts wrapper with theme-aware CSS vars), Badge, Avatar, Item (composable list items)
- **Navigation (5):** Sidebar (collapsible, cookie-persisted, mobile sheet, `Cmd+B` shortcut), NavigationMenu, Breadcrumb, Tabs, Pagination
- **Overlays & Modals (6):** Dialog, AlertDialog, Sheet (slide-in panel), Drawer (bottom, via Vaul), Tooltip, HoverCard
- **Dropdowns & Menus (4):** DropdownMenu, ContextMenu, Menubar, Command palette (cmdk)
- **Feedback & Status (5):** Alert, Toaster (Sonner), Progress, Skeleton, Spinner
- **Layout & Structure (9):** Card, Separator, ScrollArea, ResizablePanel, AspectRatio, Collapsible, ButtonGroup, Empty state, Popover
- **Miscellaneous (5):** Accordion, Carousel (Embla), Toggle, ToggleGroup, Kbd (keyboard shortcut display)

## SEO

- Dynamic `<title>` and `<meta description>` via `<SEO>` component on all public pages
- Open Graph tags: type, title, description, URL, site name, image (1200x630)
- Twitter Card tags: summary_large_image, title, description, image
- `robots.txt` with disallow rules for `/dashboard`, `/settings`, `/admin`, `/api/`
- Build-time sitemap generation (`sitemap.xml`) with static and dynamic routes (blog, changelog, docs)
- Build-time RSS feed generation (`rss.xml`) for blog posts
- RSS auto-discovery via `<link rel="alternate">` in HTML head
- AI-crawlable pages out of the box (GEO): build-time `llms.txt` + `llms-full.txt` (llmstxt.org convention), per-page markdown mirrors at `/{docs,blog,changelog}/<slug>.md`, and per-route `<title>`/meta/Open Graph/canonical/JSON-LD plus rendered content HTML injected into the SPA shell by the Hono server — so GPTBot, ClaudeBot, PerplexityBot, and Bingbot see real content without JavaScript, no prerendering or SSR framework
- AI Visibility admin dashboard — user-agent classified crawler hits (GPTBot, ClaudeBot, PerplexityBot, Googlebot, Bingbot, and more) grouped by AI search / AI training / search engine, with a daily trend chart, per-crawler totals, and a most-crawled-pages table; no IPs stored, 90-day raw retention with nightly `pg_cron` rollups into a permanent daily table
- Heading anchor links in MDX content for deep-linking

## Onboarding

- Automatic redirect for new users (gate in `ProtectedRoute`, checks `onboarding_completed` metadata)
- Billing page exempt from redirect (allows Stripe checkout to complete)
- 3-step linear wizard with progress indicator:
  1. **Profile**, collecting the display name (pre-filled from OAuth or sign-up)
  2. **Organization**, creating the first org (skippable)
  3. **Plan**, selecting Free/Startup/Pro (paid plans redirect to Stripe checkout)
- Completion flag stored in Supabase Auth user metadata
- Redirects to dashboard on finish (replaces history entry)
- Invite step translations pre-defined for future use
- Fully internationalized via i18next

## Infrastructure & Deployment

- Docker Compose for local development (full Supabase stack + Traefik + Kong)
- Production overlay (`docker-compose.prod.yml`) for SSL, registry images, production env vars
- Per-project container naming and port offset system (run multiple projects simultaneously)
- Compose-based HA: multi-region Docker Compose with PostgreSQL streaming replication and one-command failover
- Kubernetes manifests for production (Kustomize-based with overlays per region)
  - App: Deployment, Service, HPA (2-10 replicas, CPU 70%, memory 80%), PodDisruptionBudget
  - Full self-hosted Supabase stack: auth, db, imgproxy, kong, meta, realtime, rest, storage, studio
  - Traefik with IngressRoute, middlewares, cert-manager integration
  - Network policies, RBAC, service accounts
  - Local OCI registry (`local-registry.yaml`) for k3s image distribution without external registry
- Hetzner Cloud as deployment target
  - Interactive region selection (Nuremberg, Helsinki, Falkenstein, Ashburn, Hillsboro)
  - Dynamic server type fetching from Hetzner API
  - Guided API token setup
  - Hetzner S3 Object Storage for backups
- DigitalOcean fully supported for all four modes — compose, compose-ha, k8s, and k8s-ha — with the same CLI, lifecycle, and e2e gate as Hetzner
  - Interactive region selection, guided API token + Spaces key setup
  - DigitalOcean Spaces object storage for backups
  - Requesting a tier a provider hasn't built fails loudly with the capability-gate error, e.g. on Linode: `Linode does not support the 'k8s' deploy tier. Supported: compose, compose-ha. (k8s: Hetzner Cloud, DigitalOcean only)`
- Linode supported for compose and compose-ha, with the same CLI, lifecycle, and e2e gate as Hetzner; k8s is not supported on Linode
  - Interactive region selection, guided API token + Object Storage key setup
  - Linode Object Storage for backups
- Vultr supported for compose and compose-ha, with the same CLI, lifecycle, and e2e gate as Hetzner; k8s is not supported on Vultr
  - Interactive region selection, guided API token + Object Storage key setup
  - Vultr Object Storage for backups
- Scaleway supported for compose and compose-ha, with the same CLI, lifecycle, and e2e gate as Hetzner; k8s and k8s-ha are not supported on Scaleway
  - Interactive region selection (Paris `fr-par-1`/`fr-par-2`, Amsterdam `nl-ams-1`/`nl-ams-2`)
  - Guided API secret key setup (`SCALEWAY_SECRET_KEY`)
  - Scaleway Object Storage for backups
- Hetzner DNS by default (same API token as servers), Cloudflare DNS opt-in (auto-creates A records), or manual DNS with printed instructions
- Automatic TLS via cert-manager + Let's Encrypt
- High availability (HA) multi-region deployment
  - Compose-based HA: primary + standby VPS with PostgreSQL streaming replication
  - Kubernetes-based HA: full k3s clusters per region with PostgreSQL streaming replication
  - Failover is deliberate: one command promotes the standby and repoints DNS
- Failover (`vibecarbon failover`)
  - Dry-run mode to preview plan
  - PostgreSQL promotion on standby
  - Service scale-up on standby region
  - Health check polling before declaring complete
  - Handles HA+Cloudflare, HA+ManualDNS, and single-server scenarios
- Automated backups
  - Scheduled backups (daily default, every 6 hours in production; CronJob on K8s, cron on Compose)
  - S3 backend with auto-created bucket
  - Configurable retention (7 days default, 30 days production)
  - Manual backup trigger, list, and download
  - Restore from backup (`vibecarbon restore`)
- CI/CD via GitHub Actions
  - Auto-generated workflow: test (lint + typecheck + test) → build (Docker image to ghcr.io) → deploy (SSH)
  - Package manager auto-detection for correct CI setup
  - GitHub secrets management via `gh secret set`
  - Deployment monitoring via `gh run list` polling
- Pulumi programs for Hetzner and DigitalOcean infrastructure, and Cloudflare DNS
- Flux GitOps support on the Kubernetes modes, opt-in via `vibecarbon configure cicd <env>` after a cluster is up; deploys themselves stay local-first. The GitHub Actions build/deploy workflows the same command installs are free in every mode
- Pod autoscaling via Kubernetes HPA (2-10 replicas); worker nodes and server sizes scale via `vibecarbon scale`

## Observability (add-on)

- Prometheus for metrics collection
- Grafana for dashboards (pre-provisioned: logs overview, system overview, PostgreSQL)
- Loki for log aggregation
- Promtail for log shipping
- postgres-exporter for database metrics
- Accessible at prometheus.localhost, grafana.localhost, loki.localhost
- Kubernetes manifests included
- Infrastructure dashboard in admin panel shows service health and latency

## Developer Experience

- Full CLI (`vibecarbon create/up/down/reset/deploy/destroy/add/remove/configure/status/backup/restore/failover/scale/upgrade`)
- Interactive prompts via `@clack/prompts` with non-interactive CI mode (`-y` flag)
- Package manager support: npm (default), pnpm, bun
- Package manager version validation with upgrade hints
- Secure secret generation at project creation (JWT, DB password, API keys)
- Placeholder validation after generation (warns on remaining `{{PLACEHOLDER}}` patterns)
- TypeScript across client, server, and shared code with strict type checking
- Path aliases: `@/*` for client, `@shared/*` for shared code
- Type-safe Supabase client via generated `Database` type
- Biome for linting and formatting
- Vitest test suite (unit, E2E, smoke, infrastructure tests)
- Vite dev server with HMR for React client
- `tsx watch` for API server with auto-restart on changes
- `concurrently` runs both dev servers via `npm run dev`
- Multi-stage Docker build (build + minimal runtime)
- `vibecarbon status` command
  - Local health: API server, Vite, Docker containers (PostgreSQL, Kong, Auth, REST, Realtime, Storage, Studio)
  - Remote health: HTTPS check with latency
  - Hetzner server status (optional, via API token)
  - Git sync tracking (deployed commit SHA, commits ahead)
  - Monthly cost estimation
  - JSON output mode for scripting/CI
  - Global registry: list all Vibecarbon projects on the machine
- AI development experience
  - Agent team: lead-coordinator + backend-engineer + frontend-engineer + security-reviewer + test-maintainer
  - Quality gate hooks: lint + typecheck on engineer idle, unit tests on QA task complete
  - Config files generated for: Claude Code (`CLAUDE.md`, `AGENTS.md`), Cursor, Windsurf, GitHub Copilot
  - Mandatory security rules in `AGENTS.md` (RLS patterns, auth checks, Zod validation)

## Optional Add-ons

- **Redis**: in-memory cache and sessions
  - Docker Compose + Kubernetes manifests
  - Auto-generated password
  - `ioredis` pre-installed in template
  - Used by rate limiter for distributed deployments
- **Observability**: Prometheus + Grafana + Loki + Promtail + postgres-exporter
- **CI/CD**: GitHub Actions workflow generation with ghcr.io image registry
- Add-ons fetched from GitHub at runtime or bundled locally (offline/air-gapped mode)
- Fuzzy matching with Levenshtein distance for typo correction on unknown feature names
- All add-ons are idempotent (safe to re-run)
