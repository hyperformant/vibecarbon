import {
  bigint,
  boolean,
  date,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of the tables in supabase/migrations/.
 *
 * The SQL migrations are the source of truth: they own constraints, indexes,
 * foreign keys, triggers and every RLS policy. This file only describes the
 * columns so queries are typed. When a migration adds or renames a column,
 * change it here too; tests/db/schema-drift.test.ts fails until you do.
 *
 * Property names are camelCase, column names stay snake_case. Timestamps use
 * `mode: 'string'` so a value goes out exactly as Postgres returned it.
 * Started from `npx drizzle-kit pull` (see drizzle.config.ts).
 */

const tz = { withTimezone: true, mode: 'string' } as const;
const createdAt = () => timestamp('created_at', tz).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', tz).defaultNow().notNull();

export const organizations = pgTable('organizations', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  plan: text('plan').default('FREE'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable('memberships', {
  id: uuid('id').defaultRandom().primaryKey(),
  role: text('role').default('MEMBER'),
  userId: uuid('user_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const customers = pgTable('customers', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id'),
  organizationId: uuid('organization_id'),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  email: text('email'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  customerId: uuid('customer_id').notNull(),
  stripeSubscriptionId: text('stripe_subscription_id').notNull(),
  stripePriceId: text('stripe_price_id').notNull(),
  status: text('status').notNull(),
  currentPeriodStart: timestamp('current_period_start', tz),
  currentPeriodEnd: timestamp('current_period_end', tz),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false).notNull(),
  canceledAt: timestamp('canceled_at', tz),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const notifications = pgTable('notifications', {
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
});

export const notificationDismissals = pgTable('notification_dismissals', {
  id: uuid('id').defaultRandom().primaryKey(),
  notificationId: uuid('notification_id').notNull(),
  userId: uuid('user_id').notNull(),
  dismissedAt: timestamp('dismissed_at', tz).defaultNow().notNull(),
});

export const failedLoginAttempts = pgTable('failed_login_attempts', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  ipAddress: inet('ip_address').notNull(),
  attemptedAt: timestamp('attempted_at', tz).defaultNow(),
});

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').default({}).notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
});

export const cronJobHistory = pgTable('cron_job_history', {
  id: uuid('id').defaultRandom().primaryKey(),
  jobName: text('job_name').notNull(),
  status: text('status').default('running').notNull(),
  startedAt: timestamp('started_at', tz).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', tz),
  durationMs: integer('duration_ms'),
  result: text('result'),
  error: text('error'),
  createdAt: createdAt(),
});

export const contactSubmissions = pgTable('contact_submissions', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  subject: text('subject').notNull(),
  message: text('message').notNull(),
  status: text('status').default('unread').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const newsletterSubscribers = pgTable('newsletter_subscribers', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  name: text('name'),
  status: text('status').default('pending').notNull(),
  confirmationToken: uuid('confirmation_token').defaultRandom(),
  subscribedAt: timestamp('subscribed_at', tz),
  unsubscribedAt: timestamp('unsubscribed_at', tz),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const crawlerHits = pgTable('crawler_hits', {
  // bigint identity; `number` mode is safe far past any realistic row count.
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  crawler: text('crawler').notNull(),
  path: text('path').notNull(),
  userAgent: text('user_agent'),
  hitAt: timestamp('hit_at', tz).defaultNow().notNull(),
  status: smallint('status'),
});

export const crawlerHitsDaily = pgTable(
  'crawler_hits_daily',
  {
    day: date('day').notNull(),
    crawler: text('crawler').notNull(),
    path: text('path').notNull(),
    hits: integer('hits').default(0).notNull(),
    errors: integer('errors').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.day, table.crawler, table.path] })]
);
