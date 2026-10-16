import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The database schema: tables, columns, constraints, indexes, foreign keys
 * and every row-level security policy. This file is the source of truth;
 * `npx drizzle-kit generate --name <slug>` turns a change here into a SQL
 * migration in db/migrations/, and the app applies pending migrations at
 * startup (src/server/db/migrate.ts). AGENTS.md "Changing the database
 * schema" has the full workflow.
 *
 * What drizzle-kit cannot model lives in custom migrations in the same
 * folder (`npx drizzle-kit generate --custom --name <slug>`): the pg_cron
 * extension, the `app` schema and app.user_id(), the `app_user` role, the
 * SQL functions (RLS helpers, lockout, cron logging, crawler rollup),
 * triggers, grants and revokes, pg_cron schedules and seed rows. In the
 * baseline they sit in 0000_baseline_pre.sql (what the policies below call)
 * and 0002_baseline_post.sql (everything else).
 *
 * Constraint and index names are spelled out, matching Postgres' own naming
 * (`<table>_<column>_key`, `_fkey`, `_check`, `_pkey`), so the catalog reads
 * the same whatever wrote it; tests/db/migrations.test.ts pins it.
 *
 * Property names are camelCase, column names stay snake_case. Timestamps use
 * `mode: 'string'` so a value goes out exactly as Postgres returned it.
 *
 * RLS model: the server connects as a role that bypasses RLS (adminDb) and
 * runs each user request in a transaction as `app_user` with app.user_id set
 * (withUserDb, db/client.ts). Policies without `to` apply to every role
 * (PUBLIC), which in practice means `app_user`: the connection role bypasses
 * them. Policy expressions are plain SQL text so they deparse exactly as
 * written.
 */

/** The request role withUserDb switches to. Created by 0000_baseline_pre.sql. */
export const appUser = pgRole('app_user').existing();

const tz = { withTimezone: true, mode: 'string' } as const;
const createdAt = () => timestamp('created_at', tz).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', tz).defaultNow().notNull();

/** USING / WITH CHECK clause for the many super-admin-only policies. */
const superAdmin = sql`is_super_admin()`;

// Descending index columns say `.desc().nullsFirst()`: NULLS FIRST is what a
// plain `DESC` means in Postgres, and drizzle-kit would otherwise write
// `DESC NULLS LAST`, a different index.

// ---------------------------------------------------------------------------
// Auth tables, read and written only by Better Auth's drizzle adapter (and
// other server code through adminDb). The export names (user, session,
// account, verification, twoFactor) are Better Auth's model names and its
// field names are the property keys, so the adapter maps them without a
// rename table. Shape follows `npx auth generate` for the admin + twoFactor
// plugins, with uuid ids defaulting in the database (generateId: false) and
// timestamptz columns. Timestamps use the default `date` mode here because
// Better Auth reads and writes Date objects.
//
// These tables hold password hashes, session tokens, OAuth tokens and TOTP
// secrets. RLS is enabled with NO policies, which makes a table server-only:
// app.revoke_server_only_tables() (0002_baseline_post.sql, run after every
// migration) takes every privilege back from every non-superuser role, the
// RLS-bypass add-on roles included, so only the server's adminDb (the
// superuser) reads or writes them. Never add an app_user policy here; expose
// what a user may see through a server route instead.
// ---------------------------------------------------------------------------

const authTz = { withTimezone: true } as const;
const authCreatedAt = () => timestamp('created_at', authTz).defaultNow().notNull();
const authUpdatedAt = () =>
  timestamp('updated_at', authTz)
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

export const user = pgTable('user', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique('user_email_key'),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  // admin plugin. 'super_admin' is the operator role is_super_admin() checks.
  role: text('role'),
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', authTz),
  // twoFactor plugin
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  // additional field
  onboardingCompleted: boolean('onboarding_completed').default(false).notNull(),
  // Written by the app when a session is issued (auth/sign-in-record.ts),
  // never by Better Auth or the client.
  lastSignInAt: timestamp('last_sign_in_at', authTz),
  createdAt: authCreatedAt(),
  updatedAt: authUpdatedAt(),
}).enableRLS();

export const session = pgTable(
  'session',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    expiresAt: timestamp('expires_at', authTz).notNull(),
    token: text('token').notNull().unique('session_token_key'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id').notNull(),
    // admin plugin
    impersonatedBy: uuid('impersonated_by'),
    // additional field: true once this session passed a second factor
    twoFactorVerified: boolean('two_factor_verified').default(false).notNull(),
    createdAt: authCreatedAt(),
    updatedAt: authUpdatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'session_user_id_fkey',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'session_impersonated_by_fkey',
      columns: [t.impersonatedBy],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    index('idx_session_user_id').on(t.userId),
    index('idx_session_impersonated_by')
      .on(t.impersonatedBy)
      .where(sql`impersonated_by IS NOT NULL`),
  ]
).enableRLS();

export const account = pgTable(
  'account',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', authTz),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', authTz),
    scope: text('scope'),
    password: text('password'),
    createdAt: authCreatedAt(),
    updatedAt: authUpdatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'account_user_id_fkey',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    index('idx_account_user_id').on(t.userId),
  ]
).enableRLS();

export const verification = pgTable(
  'verification',
  {
    // Text, not uuid: Better Auth writes its own non-uuid ids here for
    // reservations (a hash of the identifier, e.g. the lock a magic link
    // takes on an unverified account). Nothing references it.
    id: text('id').default(sql`gen_random_uuid()::text`).primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', authTz).notNull(),
    createdAt: authCreatedAt(),
    updatedAt: authUpdatedAt(),
  },
  (t) => [index('idx_verification_identifier').on(t.identifier)]
).enableRLS();

export const twoFactor = pgTable(
  'two_factor',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: uuid('user_id').notNull(),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: timestamp('locked_until', authTz),
  },
  (t) => [
    foreignKey({
      name: 'two_factor_user_id_fkey',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    index('idx_two_factor_secret').on(t.secret),
    index('idx_two_factor_user_id').on(t.userId),
  ]
).enableRLS();

// ---------------------------------------------------------------------------
// Organizations and memberships
// ---------------------------------------------------------------------------

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    // UNIQUE already creates the index slug lookups use.
    slug: text('slug').notNull().unique('organizations_slug_key'),
    plan: text('plan').default('FREE'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    check('organizations_plan_check', sql`plan IN ('FREE', 'STARTER', 'PRO', 'ENTERPRISE')`),
    pgPolicy('Users can view their organizations', {
      for: 'select',
      using: sql`id IN (SELECT get_user_org_ids())`,
    }),
    pgPolicy('Authenticated users can create organizations', {
      for: 'insert',
      withCheck: sql`(SELECT app.user_id()) IS NOT NULL`,
    }),
    // Explicit WITH CHECK mirroring USING (defense-in-depth): id is an
    // immutable PK so the implicit default is safe today, but a boundary
    // policy must never rely on that. An explicit org-scoped check keeps any
    // future updatable column from silently becoming a cross-tenant write.
    // `plan` remains admin-writable but is display-only (entitlement
    // resolves from subscriptions via requirePlan), so a self-set plan is
    // cosmetic.
    pgPolicy('Owners and admins can update organizations', {
      for: 'update',
      using: sql`id IN (SELECT get_user_admin_org_ids())`,
      withCheck: sql`id IN (SELECT get_user_admin_org_ids())`,
    }),
    pgPolicy('Owners can delete organizations', {
      for: 'delete',
      using: sql`id IN (SELECT get_user_owner_org_ids())`,
    }),
  ]
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    role: text('role').default('MEMBER'),
    userId: uuid('user_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('memberships_role_check', sql`role IN ('OWNER', 'ADMIN', 'MEMBER')`),
    foreignKey({
      name: 'memberships_user_id_fkey',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'memberships_organization_id_fkey',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    unique('memberships_user_id_organization_id_key').on(t.userId, t.organizationId),
    index('idx_memberships_user_id').on(t.userId),
    index('idx_memberships_organization_id').on(t.organizationId),
    pgPolicy('Users can view memberships in their organizations', {
      for: 'select',
      using: sql`organization_id IN (SELECT get_user_org_ids())`,
    }),
    pgPolicy('Admins can add non-owner members', {
      for: 'insert',
      withCheck: sql`organization_id IN (SELECT get_user_admin_org_ids())
    AND role IN ('ADMIN', 'MEMBER')`,
    }),
    pgPolicy('Owners can add any member', {
      for: 'insert',
      withCheck: sql`organization_id IN (SELECT get_user_owner_org_ids())`,
    }),
    // WITH CHECK MUST mirror the org scope of USING. Postgres evaluates a
    // permissive policy's USING and WITH CHECK independently, so a WITH CHECK
    // of only `role <> 'OWNER'` would let an admin PATCH a row they
    // legitimately see (in their org) and rewrite organization_id/user_id to
    // an org they do NOT administer: a cross-tenant takeover (land as ADMIN
    // of any org, then read its members, customers, and billing via the
    // other correct policies). The org-id scope here is the boundary; keep it.
    pgPolicy('Admins can update non-owner memberships', {
      for: 'update',
      using: sql`organization_id IN (SELECT get_user_admin_org_ids())
    AND role <> 'OWNER'`,
      withCheck: sql`organization_id IN (SELECT get_user_admin_org_ids())
    AND role <> 'OWNER'`,
    }),
    pgPolicy('Owners can update any membership', {
      for: 'update',
      using: sql`organization_id IN (SELECT get_user_owner_org_ids())`,
      withCheck: sql`organization_id IN (SELECT get_user_owner_org_ids())`,
    }),
    pgPolicy('Users can leave or be removed by owners/admins', {
      for: 'delete',
      using: sql`user_id = (SELECT app.user_id())
    OR organization_id IN (SELECT get_user_admin_org_ids())`,
    }),
  ]
);

// ---------------------------------------------------------------------------
// Billing (Stripe)
// ---------------------------------------------------------------------------

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id'),
    organizationId: uuid('organization_id'),
    // UNIQUE already creates the index; a separate idx_ would be a duplicate.
    stripeCustomerId: text('stripe_customer_id')
      .notNull()
      .unique('customers_stripe_customer_id_key'),
    email: text('email'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'customer_type',
      sql`(user_id IS NOT NULL AND organization_id IS NULL) OR
    (user_id IS NULL AND organization_id IS NOT NULL)`
    ),
    foreignKey({
      name: 'customers_user_id_fkey',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'customers_organization_id_fkey',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    uniqueIndex('idx_customers_user_id').on(t.userId).where(sql`user_id IS NOT NULL`),
    uniqueIndex('idx_customers_organization_id')
      .on(t.organizationId)
      .where(sql`organization_id IS NOT NULL`),
    pgPolicy('Users can view their own customer records', {
      for: 'select',
      using: sql`user_id = (SELECT app.user_id()) OR
    organization_id IN (SELECT get_user_org_ids())`,
    }),
    // No client INSERT policy: every customer row is created server-side by
    // getOrCreateCustomer through adminDb (which bypasses RLS), exactly like
    // `subscriptions`. A client INSERT policy would be needless write surface
    // on a billing table: it would let any signed-in user insert a customer
    // row with an arbitrary stripe_customer_id (squatting a not-yet-created
    // provider id to break a victim's future checkout via the UNIQUE
    // constraint).
  ]
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    customerId: uuid('customer_id').notNull(),
    // UNIQUE already creates the index; a separate idx_ would be a duplicate.
    stripeSubscriptionId: text('stripe_subscription_id')
      .notNull()
      .unique('subscriptions_stripe_subscription_id_key'),
    stripePriceId: text('stripe_price_id').notNull(),
    status: text('status').notNull(),
    currentPeriodStart: timestamp('current_period_start', tz),
    currentPeriodEnd: timestamp('current_period_end', tz),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false).notNull(),
    canceledAt: timestamp('canceled_at', tz),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'subscriptions_status_check',
      sql`status IN ('active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'trialing', 'unpaid', 'paused')`
    ),
    foreignKey({
      name: 'subscriptions_customer_id_fkey',
      columns: [t.customerId],
      foreignColumns: [customers.id],
    }).onDelete('cascade'),
    index('idx_subscriptions_customer_id').on(t.customerId),
    index('idx_subscriptions_status').on(t.status),
    // Subscriptions are written by the Stripe webhook through adminDb.
    pgPolicy('Users can view their own subscriptions', {
      for: 'select',
      using: sql`customer_id IN (SELECT get_user_customer_ids())`,
    }),
  ]
);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    title: text('title').notNull(),
    message: text('message'),
    type: text('type').default('info'),
    visibility: text('visibility').default('all'),
    dismissible: boolean('dismissible').default(true),
    organizationId: uuid('organization_id'),
    startsAt: timestamp('starts_at', tz).defaultNow(),
    endsAt: timestamp('ends_at', tz),
    actionLabel: text('action_label'),
    actionUrl: text('action_url'),
    isActive: boolean('is_active').default(true),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('notifications_type_check', sql`type IN ('info', 'warning', 'error', 'success')`),
    check('notifications_visibility_check', sql`visibility IN ('all', 'authenticated', 'public')`),
    foreignKey({
      name: 'notifications_organization_id_fkey',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'notifications_created_by_fkey',
      columns: [t.createdBy],
      foreignColumns: [user.id],
    }).onDelete('set null'),
    index('idx_notifications_active')
      .on(t.isActive, t.startsAt, t.endsAt)
      .where(sql`is_active = true`),
    index('idx_notifications_org').on(t.organizationId).where(sql`organization_id IS NOT NULL`),
    // Covering index for the created_by FK (avoids seq scans on "user" deletes).
    index('idx_notifications_created_by').on(t.createdBy).where(sql`created_by IS NOT NULL`),
    // The two read policies split on whether the request carries a user id:
    // both target app_user, so the id check is what keeps an anonymous
    // request from seeing 'authenticated'-only notifications (and a
    // signed-in one from seeing 'public'-only ones).
    pgPolicy('Authenticated users can view relevant notifications', {
      for: 'select',
      to: appUser,
      using: sql`(SELECT app.user_id()) IS NOT NULL
    AND is_active = true
    AND (starts_at IS NULL OR starts_at <= NOW())
    AND (ends_at IS NULL OR ends_at > NOW())
    AND (visibility IN ('all', 'authenticated'))
    AND (
      organization_id IS NULL
      OR organization_id IN (SELECT get_user_org_ids())
    )`,
    }),
    pgPolicy('Anonymous users can view public notifications', {
      for: 'select',
      to: appUser,
      using: sql`(SELECT app.user_id()) IS NULL
    AND is_active = true
    AND (starts_at IS NULL OR starts_at <= NOW())
    AND (ends_at IS NULL OR ends_at > NOW())
    AND (visibility IN ('all', 'public'))
    AND organization_id IS NULL`,
    }),
    pgPolicy('Super admins can create notifications', { for: 'insert', withCheck: superAdmin }),
    pgPolicy('Super admins can update notifications', {
      for: 'update',
      using: superAdmin,
      withCheck: superAdmin,
    }),
    pgPolicy('Super admins can delete notifications', { for: 'delete', using: superAdmin }),
  ]
);

export const notificationDismissals = pgTable(
  'notification_dismissals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    notificationId: uuid('notification_id').notNull(),
    userId: uuid('user_id').notNull(),
    dismissedAt: timestamp('dismissed_at', tz).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'notification_dismissals_notification_id_fkey',
      columns: [t.notificationId],
      foreignColumns: [notifications.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'notification_dismissals_user_id_fkey',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    unique('notification_dismissals_notification_id_user_id_key').on(t.notificationId, t.userId),
    index('idx_notification_dismissals_user').on(t.userId, t.notificationId),
    pgPolicy('Users can view their dismissals', {
      for: 'select',
      using: sql`user_id = (SELECT app.user_id())`,
    }),
    pgPolicy('Users can dismiss notifications', {
      for: 'insert',
      withCheck: sql`user_id = (SELECT app.user_id())`,
    }),
    pgPolicy('Users can remove their dismissals', {
      for: 'delete',
      using: sql`user_id = (SELECT app.user_id())`,
    }),
  ]
);

// ---------------------------------------------------------------------------
// Auth security and settings
// ---------------------------------------------------------------------------

/** Brute-force protection; written and read through the lockout functions. */
export const failedLoginAttempts = pgTable(
  'failed_login_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    ipAddress: inet('ip_address').notNull(),
    attemptedAt: timestamp('attempted_at', tz).defaultNow(),
  },
  (t) => [
    index('idx_failed_login_attempts_lookup').on(
      t.email,
      t.ipAddress,
      t.attemptedAt.desc().nullsFirst()
    ),
    index('idx_failed_login_attempts_time').on(t.attemptedAt),
  ]
).enableRLS();

/**
 * Global application settings.
 *
 * WARNING: whitelisted keys are readable by anonymous requests to support
 * pre-authentication flows (e.g. checking if MFA is enforced). DO NOT STORE
 * SECRETS, TOKENS, OR SENSITIVE ENVIRONMENT VARIABLES HERE. Public access is
 * strictly controlled by the whitelist policy below; add a key there only if
 * an anonymous page must read it.
 */
export const appSettings = pgTable(
  'app_settings',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').default({}).notNull(),
    updatedBy: uuid('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'app_settings_updated_by_fkey',
      columns: [t.updatedBy],
      foreignColumns: [user.id],
    }).onDelete('set null'),
    // Covering index for the updated_by FK (avoids seq scans on "user" deletes).
    index('idx_app_settings_updated_by').on(t.updatedBy).where(sql`updated_by IS NOT NULL`),
    pgPolicy('Public can read whitelisted settings', {
      for: 'select',
      using: sql`key IN (
    'mfa_enabled',
    'app_theme',
    'user_docs_enabled',
    'api_docs_enabled'
  )`,
    }),
    pgPolicy('Super admins can read all settings', { for: 'select', using: superAdmin }),
    pgPolicy('Super admins can update app settings', {
      for: 'update',
      using: superAdmin,
      withCheck: superAdmin,
    }),
    pgPolicy('Super admins can insert app settings', { for: 'insert', withCheck: superAdmin }),
  ]
);

// ---------------------------------------------------------------------------
// Background jobs (pg_cron). The schedules and log_cron_job() are in
// 0002_baseline_post.sql.
// ---------------------------------------------------------------------------

export const cronJobHistory = pgTable(
  'cron_job_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobName: text('job_name').notNull(),
    // running, succeeded, failed
    status: text('status').default('running').notNull(),
    startedAt: timestamp('started_at', tz).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', tz),
    durationMs: integer('duration_ms'),
    result: text('result'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_cron_job_history_job_name').on(t.jobName),
    index('idx_cron_job_history_started_at').on(t.startedAt.desc().nullsFirst()),
    pgPolicy('Super admins can read job history', { for: 'select', using: superAdmin }),
  ]
);

// ---------------------------------------------------------------------------
// Contact form and newsletter. Both lifecycles are server-mediated through
// adminDb (routes/v1/contact.ts, routes/v1/newsletter.ts), so there is
// deliberately NO user-request write policy: app_user holds table-level
// INSERT/UPDATE grants, and a permissive `WITH CHECK (true)` policy would let
// any request inject rows, bypass double opt-in or overwrite every
// subscriber. Super admins manage both through the policies below.
// ---------------------------------------------------------------------------

export const contactSubmissions = pgTable(
  'contact_submissions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    subject: text('subject').notNull(),
    message: text('message').notNull(),
    // unread, read, replied, archived
    status: text('status').default('unread').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_contact_submissions_status').on(t.status),
    index('idx_contact_submissions_created_at').on(t.createdAt.desc().nullsFirst()),
    pgPolicy('Super admins can manage contact submissions', { for: 'all', using: superAdmin }),
  ]
);

export const newsletterSubscribers = pgTable(
  'newsletter_subscribers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // UNIQUE already creates the index; a separate idx_ would be a duplicate.
    email: text('email').notNull().unique('newsletter_subscribers_email_key'),
    name: text('name'),
    // pending, active, unsubscribed
    status: text('status').default('pending').notNull(),
    confirmationToken: uuid('confirmation_token').defaultRandom(),
    subscribedAt: timestamp('subscribed_at', tz),
    unsubscribedAt: timestamp('unsubscribed_at', tz),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_newsletter_subscribers_status').on(t.status),
    pgPolicy('Super admins can manage newsletter subscribers', { for: 'all', using: superAdmin }),
  ]
);

// ---------------------------------------------------------------------------
// AI visibility: crawler hit tracking. Writes come only from the server's
// adminDb (middleware/crawler-tracking.ts) and the pg_cron rollup; `path` is
// bucketed against the built SEO route manifest before it gets here, so
// cardinality is days x crawlers x known routes, and both tables age out on a
// schedule (90 and 400 days). No IP address or other personal data.
//
// SECURITY: deliberately NO INSERT/UPDATE/DELETE policy on either table.
// app_user holds the blanket table-level write grants, so RLS is the only
// gate: any permissive write policy would let any user request forge
// dashboard data or grow the tables without bound.
// ---------------------------------------------------------------------------

export const crawlerHits = pgTable(
  'crawler_hits',
  {
    // bigint identity rather than a uuid: the highest-write table in the
    // schema, never referenced by anything else. `number` mode is safe far
    // past any realistic row count.
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    crawler: text('crawler').notNull(),
    path: text('path').notNull(),
    userAgent: text('user_agent'),
    hitAt: timestamp('hit_at', tz).defaultNow().notNull(),
    // The HTTP status the crawler received.
    status: smallint('status'),
  },
  (t) => [
    // (hit_at DESC): the 90-day prune and every windowed dashboard read.
    index('idx_crawler_hits_hit_at').on(t.hitAt.desc().nullsFirst()),
    // (crawler, hit_at DESC): per-crawler trend queries.
    index('idx_crawler_hits_crawler_hit_at').on(t.crawler, t.hitAt.desc().nullsFirst()),
    pgPolicy('Super admins can read crawler hits', { for: 'select', using: superAdmin }),
  ]
);

export const crawlerHitsDaily = pgTable(
  'crawler_hits_daily',
  {
    day: date('day').notNull(),
    crawler: text('crawler').notNull(),
    path: text('path').notNull(),
    hits: integer('hits').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Hits answered with a 5xx.
    errors: integer('errors').default(0).notNull(),
  },
  (t) => [
    primaryKey({ name: 'crawler_hits_daily_pkey', columns: [t.day, t.crawler, t.path] }),
    // The PK's leading `day` column already serves day-range scans (the
    // 400-day prune included); this covers per-crawler-over-time reads.
    index('idx_crawler_hits_daily_crawler_day').on(t.crawler, t.day.desc().nullsFirst()),
    pgPolicy('Super admins can read crawler hit rollups', { for: 'select', using: superAdmin }),
  ]
);
