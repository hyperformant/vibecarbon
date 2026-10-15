-- Vibecarbon Initial Migration
-- Complete database schema with multi-tenancy, billing, notifications, and security
--
-- Tables:
--   - user, session, account, verification, two_factor: Auth (server-only)
--   - organizations: Multi-tenant organization management
--   - memberships: User-organization relationships
--   - customers: Stripe billing customers
--   - subscriptions: Stripe subscriptions
--   - notifications: System-wide notifications (with visibility controls)
--   - notification_dismissals: User dismissal tracking
--   - failed_login_attempts: Brute force protection
--   - app_settings: Global application settings

-- ============================================================================
-- REQUEST ROLE AND IDENTITY (app_user + app.user_id())
-- ============================================================================
-- The server connects as a role that bypasses RLS (adminDb, `postgres`) and
-- runs every user request in a transaction that starts with ONE parameterized
-- statement:
--
--   select set_config('role', 'app_user', true),
--          set_config('app.user_id', $1, true)
--
-- so the rest of the transaction runs as `app_user` and every policy below
-- reads the caller from app.user_id(). Both settings are transaction-local
-- (is_local = true) and reset at COMMIT/ROLLBACK, so nothing leaks to the next
-- pooled request. An anonymous request sets app.user_id to '' and
-- app.user_id() returns NULL, which matches no owner/org check.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END
$$;

-- set_config('role', ...) requires membership. `postgres` is the app's
-- connection role (BYPASSRLS + LOGIN in the db image; adminDb runs as it).
GRANT app_user TO postgres;

CREATE SCHEMA IF NOT EXISTS app;

-- The caller's user id for this transaction, or NULL when anonymous. STABLE
-- and read through `(SELECT app.user_id())` in policies so the planner
-- evaluates it once per statement, not once per row.
CREATE OR REPLACE FUNCTION app.user_id()
RETURNS UUID
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid;
$$;

GRANT USAGE ON SCHEMA public, app TO app_user;
GRANT EXECUTE ON FUNCTION app.user_id() TO app_user;

-- Table access is broad on purpose: RLS (enabled on every table below) is
-- the boundary.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- Functions get EXECUTE through default privileges at creation time (the RLS
-- helpers below need it, since policies run as app_user). There is
-- deliberately no `GRANT EXECUTE ON ALL FUNCTIONS`: migrations re-run on every
-- deploy, and a blanket re-grant would re-open the server-only SECURITY
-- DEFINER functions (lockout, cron log, crawler rollup) until each file's
-- REVOKE ran again. Every such function MUST `REVOKE EXECUTE ... FROM PUBLIC,
-- app_user` in the migration that creates it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO app_user;

-- ============================================================================
-- UPDATED_AT TRIGGER FUNCTION (used by multiple tables)
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ============================================================================
-- AUTH TABLES (user, session, account, verification, two_factor)
-- ============================================================================
-- The app's own accounts, written and read by Better Auth (drizzle adapter,
-- server-side only, through adminDb). Column names follow Better Auth's
-- generated schema in snake_case; ids are uuid with a database default
-- (Better Auth runs with advanced.database.generateId: false) so every other
-- table's `user_id UUID` foreign key points straight at "user"(id).
-- `role`, `banned`, `ban_reason`, `ban_expires` and session.impersonated_by
-- belong to the admin plugin; user.two_factor_enabled and the two_factor
-- table to the twoFactor plugin. `onboarding_completed` and
-- session.two_factor_verified are this app's additional fields.
--
-- These tables hold password hashes, session tokens, OAuth tokens and TOTP
-- secrets. RLS is enabled with NO policies and every request role's
-- privileges are revoked below: only the server's adminDb (BYPASSRLS) reads
-- or writes them. Never add an app_user policy here; expose what a user may
-- see through a server route instead.

CREATE TABLE IF NOT EXISTS "user" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN DEFAULT FALSE NOT NULL,
  image TEXT,
  -- Admin plugin. 'super_admin' is the operator role is_super_admin() checks.
  role TEXT,
  banned BOOLEAN DEFAULT FALSE,
  ban_reason TEXT,
  ban_expires TIMESTAMPTZ,
  two_factor_enabled BOOLEAN DEFAULT FALSE,
  onboarding_completed BOOLEAN DEFAULT FALSE NOT NULL,
  -- Set by the app when a session is issued (not by the auth library).
  last_sign_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expires_at TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  impersonated_by UUID REFERENCES "user"(id) ON DELETE CASCADE,
  two_factor_verified BOOLEAN DEFAULT FALSE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_user_id ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_impersonated_by
  ON session(impersonated_by)
  WHERE impersonated_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  scope TEXT,
  password TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_user_id ON account(user_id);

-- verification.id is TEXT, unlike the other auth ids: Better Auth writes its
-- own non-uuid ids here for reservations (a hash of the identifier, e.g. the
-- lock a magic link takes on an unverified account). Nothing references it.
CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verification_identifier ON verification(identifier);

CREATE TABLE IF NOT EXISTS two_factor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secret TEXT NOT NULL,
  backup_codes TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  verified BOOLEAN DEFAULT TRUE,
  failed_verification_count INTEGER DEFAULT 0,
  locked_until TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_two_factor_secret ON two_factor(secret);
CREATE INDEX IF NOT EXISTS idx_two_factor_user_id ON two_factor(user_id);

ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE session ENABLE ROW LEVEL SECURITY;
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE two_factor ENABLE ROW LEVEL SECURITY;

-- Server-only: revoke every role that is neither a superuser nor RLS-bypass,
-- including what the GRANT ON ALL TABLES above (re-run on every deploy) and
-- the default privileges just gave app_user. Role-agnostic on purpose: the
-- loop also catches roles the database image or an optional service creates
-- (metabase gets default SELECT on public tables), so only the owner and the
-- connection role behind adminDb can read password hashes and session tokens.
-- Postgres' predefined pg_* roles are operator grants and are left alone.
REVOKE ALL ON TABLE "user", session, account, verification, two_factor FROM PUBLIC;
DO $$
DECLARE
  r TEXT;
BEGIN
  FOR r IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE NOT rolsuper AND NOT rolbypassrls AND rolname NOT LIKE 'pg\_%'
  LOOP
    EXECUTE format(
      'REVOKE ALL ON TABLE public."user", public.session, public.account, public.verification, public.two_factor FROM %I',
      r
    );
  END LOOP;
END
$$;

-- ============================================================================
-- ORGANIZATIONS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan TEXT DEFAULT 'FREE' CHECK (plan IN ('FREE', 'STARTER', 'PRO', 'ENTERPRISE')),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- No index needed for slug — the UNIQUE constraint already creates one.

-- ============================================================================
-- MEMBERSHIPS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role TEXT DEFAULT 'MEMBER' CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER')),
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(user_id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_organization_id ON memberships(organization_id);

-- ============================================================================
-- BILLING TABLES (Stripe integration)
-- ============================================================================

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES "user"(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT customer_type CHECK (
    (user_id IS NOT NULL AND organization_id IS NULL) OR
    (user_id IS NULL AND organization_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_user_id ON customers(user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_organization_id ON customers(organization_id) WHERE organization_id IS NOT NULL;
-- stripe_customer_id is UNIQUE (see column def), which already creates an index;
-- a separate idx_ would be a duplicate.

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  stripe_price_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'trialing', 'unpaid', 'paused')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT FALSE NOT NULL,
  canceled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer_id ON subscriptions(customer_id);
-- stripe_subscription_id is UNIQUE (see column def), which already creates an
-- index; a separate idx_ would be a duplicate.
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- ============================================================================
-- NOTIFICATIONS TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  message TEXT,
  type TEXT DEFAULT 'info' CHECK (type IN ('info', 'warning', 'error', 'success')),
  visibility TEXT DEFAULT 'all' CHECK (visibility IN ('all', 'authenticated', 'public')),
  dismissible BOOLEAN DEFAULT true,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ DEFAULT NOW(),
  ends_at TIMESTAMPTZ,
  action_label TEXT,
  action_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_active
  ON notifications(is_active, starts_at, ends_at)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_notifications_org
  ON notifications(organization_id)
  WHERE organization_id IS NOT NULL;

-- Covering index for the created_by FK (avoids seq scans on "user" deletes).
CREATE INDEX IF NOT EXISTS idx_notifications_created_by
  ON notifications(created_by)
  WHERE created_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_dismissals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  dismissed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(notification_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_dismissals_user
  ON notification_dismissals(user_id, notification_id);

-- ============================================================================
-- AUTH SECURITY TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS failed_login_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  ip_address INET NOT NULL,
  attempted_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failed_login_attempts_lookup
  ON failed_login_attempts(email, ip_address, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_failed_login_attempts_time
  ON failed_login_attempts(attempted_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES "user"(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Covering index for the updated_by FK (avoids seq scans on "user" deletes).
CREATE INDEX IF NOT EXISTS idx_app_settings_updated_by
  ON app_settings(updated_by)
  WHERE updated_by IS NOT NULL;

-- WARNING: whitelisted keys in this table are readable by anonymous requests
-- to support pre-authentication flows (e.g. checking if MFA is enforced).
-- DO NOT STORE SECRETS, TOKENS, OR SENSITIVE ENVIRONMENT VARIABLES HERE.
-- Public access is strictly controlled via the RLS policy below.

INSERT INTO app_settings (key, value)
VALUES ('mfa_enabled', '{"enabled": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) - Enable on all tables
-- ============================================================================

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_dismissals ENABLE ROW LEVEL SECURITY;
ALTER TABLE failed_login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- HELPER FUNCTIONS (SECURITY DEFINER to bypass RLS for policy checks)
-- ============================================================================

-- Get organization IDs for current user
CREATE OR REPLACE FUNCTION get_user_org_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT organization_id FROM public.memberships WHERE user_id = app.user_id();
$$;

-- Get organization IDs where user is owner/admin
CREATE OR REPLACE FUNCTION get_user_admin_org_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT organization_id FROM public.memberships
  WHERE user_id = app.user_id() AND role IN ('OWNER', 'ADMIN');
$$;

-- Get organization IDs where user is owner
CREATE OR REPLACE FUNCTION get_user_owner_org_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT organization_id FROM public.memberships
  WHERE user_id = app.user_id() AND role = 'OWNER';
$$;

-- Get customer IDs for the current user
CREATE OR REPLACE FUNCTION get_user_customer_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id FROM public.customers c
  WHERE c.user_id = (SELECT app.user_id())
  UNION
  SELECT c.id FROM public.customers c
  WHERE c.organization_id IN (SELECT public.get_user_org_ids());
$$;

-- Check if the current user is a super admin. The role is "user".role, which
-- only the server sets (Better Auth's admin plugin; the column is not
-- user-writable through any auth endpoint). SECURITY DEFINER because app_user
-- has no privileges on "user" (see AUTH TABLES above).
CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    (
      SELECT u.role = 'super_admin'
      FROM public."user" u
      WHERE u.id = (SELECT app.user_id())
    ),
    false
  );
$$;

-- Policies run as app_user, so it must be able to call the helpers. Explicit
-- (not only via default privileges) so a database migrated before app_user
-- existed gets the grant on re-run too.
GRANT EXECUTE ON FUNCTION
  get_user_org_ids(),
  get_user_admin_org_ids(),
  get_user_owner_org_ids(),
  get_user_customer_ids(),
  is_super_admin()
TO app_user;

-- ============================================================================
-- ORGANIZATIONS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their organizations" ON organizations;
CREATE POLICY "Users can view their organizations"
  ON organizations FOR SELECT
  USING (id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "Authenticated users can create organizations" ON organizations;
CREATE POLICY "Authenticated users can create organizations"
  ON organizations FOR INSERT
  WITH CHECK ((SELECT app.user_id()) IS NOT NULL);

DROP POLICY IF EXISTS "Owners and admins can update organizations" ON organizations;
CREATE POLICY "Owners and admins can update organizations"
  ON organizations FOR UPDATE
  USING (id IN (SELECT get_user_admin_org_ids()))
  -- Explicit WITH CHECK mirroring USING (defense-in-depth): id is an immutable
  -- PK so the implicit default is safe today, but a boundary policy must never
  -- rely on that — an explicit org-scoped check keeps any future updatable
  -- column from silently becoming a cross-tenant write. `plan` remains
  -- admin-writable but is display-only (entitlement resolves from
  -- subscriptions via requirePlan), so a self-set plan is cosmetic.
  WITH CHECK (id IN (SELECT get_user_admin_org_ids()));

DROP POLICY IF EXISTS "Owners can delete organizations" ON organizations;
CREATE POLICY "Owners can delete organizations"
  ON organizations FOR DELETE
  USING (id IN (SELECT get_user_owner_org_ids()));

-- ============================================================================
-- MEMBERSHIPS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view memberships in their organizations" ON memberships;
CREATE POLICY "Users can view memberships in their organizations"
  ON memberships FOR SELECT
  USING (organization_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "Owners and admins can add members" ON memberships;
DROP POLICY IF EXISTS "Admins can add non-owner members" ON memberships;
CREATE POLICY "Admins can add non-owner members"
  ON memberships FOR INSERT
  WITH CHECK (
    organization_id IN (SELECT get_user_admin_org_ids())
    AND role IN ('ADMIN', 'MEMBER')
  );

DROP POLICY IF EXISTS "Owners can add any member" ON memberships;
CREATE POLICY "Owners can add any member"
  ON memberships FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_owner_org_ids()));

DROP POLICY IF EXISTS "Owners and admins can update memberships" ON memberships;
DROP POLICY IF EXISTS "Admins can update non-owner memberships" ON memberships;
CREATE POLICY "Admins can update non-owner memberships"
  ON memberships FOR UPDATE
  USING (
    organization_id IN (SELECT get_user_admin_org_ids())
    AND role <> 'OWNER'
  )
  -- WITH CHECK MUST mirror the org scope of USING. Postgres evaluates a
  -- permissive policy's USING and WITH CHECK independently, so a WITH CHECK of
  -- only `role <> 'OWNER'` would let an admin PATCH a row they legitimately
  -- see (in their org) and rewrite organization_id/user_id to an org they do
  -- NOT administer — a cross-tenant takeover (land as ADMIN of any org, then
  -- read its members, customers, and billing via the other correct policies).
  -- The org-id scope here is the boundary; keep it.
  WITH CHECK (
    organization_id IN (SELECT get_user_admin_org_ids())
    AND role <> 'OWNER'
  );

DROP POLICY IF EXISTS "Owners can update any membership" ON memberships;
CREATE POLICY "Owners can update any membership"
  ON memberships FOR UPDATE
  USING (organization_id IN (SELECT get_user_owner_org_ids()))
  WITH CHECK (organization_id IN (SELECT get_user_owner_org_ids()));

DROP POLICY IF EXISTS "Users can leave or be removed by owners/admins" ON memberships;
CREATE POLICY "Users can leave or be removed by owners/admins"
  ON memberships FOR DELETE
  USING (
    user_id = (SELECT app.user_id())
    OR organization_id IN (SELECT get_user_admin_org_ids())
  );

-- ============================================================================
-- CUSTOMERS POLICIES (Billing)
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own customer records" ON customers;
CREATE POLICY "Users can view their own customer records"
  ON customers FOR SELECT
  USING (
    user_id = (SELECT app.user_id()) OR
    organization_id IN (SELECT get_user_org_ids())
  );

-- No client INSERT policy on `customers`: every customer row is created
-- server-side by getOrCreateCustomer through adminDb (which bypasses RLS),
-- exactly like `subscriptions`. A client INSERT policy here was needless write
-- surface on a billing table: it let any signed-in user insert a customer row
-- with an arbitrary stripe_customer_id (squatting a
-- not-yet-created provider id to break a victim's future checkout via the
-- UNIQUE constraint). Dropped; recreated on every deploy as a no-op.
DROP POLICY IF EXISTS "Users can create customer records for themselves" ON customers;

-- ============================================================================
-- SUBSCRIPTIONS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own subscriptions" ON subscriptions;
CREATE POLICY "Users can view their own subscriptions"
  ON subscriptions FOR SELECT
  USING (customer_id IN (SELECT get_user_customer_ids()));

-- Note: Subscriptions are created/updated via webhooks using service role key

-- ============================================================================
-- NOTIFICATIONS POLICIES
-- ============================================================================

-- The two notification read policies split on whether the request carries a
-- user id: both target app_user, so the id check is what keeps an anonymous
-- request from seeing 'authenticated'-only notifications (and a signed-in one
-- from seeing 'public'-only ones).
DROP POLICY IF EXISTS "Authenticated users can view relevant notifications" ON notifications;
CREATE POLICY "Authenticated users can view relevant notifications"
  ON notifications FOR SELECT
  TO app_user
  USING (
    (SELECT app.user_id()) IS NOT NULL
    AND is_active = true
    AND (starts_at IS NULL OR starts_at <= NOW())
    AND (ends_at IS NULL OR ends_at > NOW())
    AND (visibility IN ('all', 'authenticated'))
    AND (
      organization_id IS NULL
      OR organization_id IN (SELECT get_user_org_ids())
    )
  );

DROP POLICY IF EXISTS "Anonymous users can view public notifications" ON notifications;
CREATE POLICY "Anonymous users can view public notifications"
  ON notifications FOR SELECT
  TO app_user
  USING (
    (SELECT app.user_id()) IS NULL
    AND is_active = true
    AND (starts_at IS NULL OR starts_at <= NOW())
    AND (ends_at IS NULL OR ends_at > NOW())
    AND (visibility IN ('all', 'public'))
    AND organization_id IS NULL
  );

DROP POLICY IF EXISTS "Super admins can create notifications" ON notifications;
CREATE POLICY "Super admins can create notifications"
  ON notifications FOR INSERT
  WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS "Super admins can update notifications" ON notifications;
CREATE POLICY "Super admins can update notifications"
  ON notifications FOR UPDATE
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS "Super admins can delete notifications" ON notifications;
CREATE POLICY "Super admins can delete notifications"
  ON notifications FOR DELETE
  USING (is_super_admin());

-- ============================================================================
-- NOTIFICATION DISMISSALS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their dismissals" ON notification_dismissals;
CREATE POLICY "Users can view their dismissals"
  ON notification_dismissals FOR SELECT
  USING (user_id = (SELECT app.user_id()));

DROP POLICY IF EXISTS "Users can dismiss notifications" ON notification_dismissals;
CREATE POLICY "Users can dismiss notifications"
  ON notification_dismissals FOR INSERT
  WITH CHECK (user_id = (SELECT app.user_id()));

DROP POLICY IF EXISTS "Users can remove their dismissals" ON notification_dismissals;
CREATE POLICY "Users can remove their dismissals"
  ON notification_dismissals FOR DELETE
  USING (user_id = (SELECT app.user_id()));

-- ============================================================================
-- APP SETTINGS POLICIES
-- ============================================================================

-- Public access is limited to a whitelist of safe keys. Add new keys here as needed.
DROP POLICY IF EXISTS "Anyone can read app settings" ON app_settings;
DROP POLICY IF EXISTS "Public can read whitelisted settings" ON app_settings;
CREATE POLICY "Public can read whitelisted settings"
  ON app_settings FOR SELECT
  USING (key IN ('mfa_enabled'));

DROP POLICY IF EXISTS "Super admins can read all settings" ON app_settings;
CREATE POLICY "Super admins can read all settings"
  ON app_settings FOR SELECT
  USING (is_super_admin());

DROP POLICY IF EXISTS "Super admins can update app settings" ON app_settings;
CREATE POLICY "Super admins can update app settings"
  ON app_settings FOR UPDATE
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS "Super admins can insert app settings" ON app_settings;
CREATE POLICY "Super admins can insert app settings"
  ON app_settings FOR INSERT
  WITH CHECK (is_super_admin());

-- ============================================================================
-- SECURITY HELPER FUNCTIONS
-- ============================================================================

-- Check if an account is locked due to too many failed attempts
CREATE OR REPLACE FUNCTION check_account_lockout(
  p_email TEXT,
  p_ip_address INET,
  p_max_attempts INTEGER DEFAULT 5,
  p_lockout_minutes INTEGER DEFAULT 15
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  attempt_count INTEGER;
  oldest_relevant TIMESTAMPTZ;
  minutes_remaining INTEGER;
BEGIN
  SELECT COUNT(*), MIN(attempted_at)
  INTO attempt_count, oldest_relevant
  FROM public.failed_login_attempts
  WHERE email = LOWER(p_email)
    AND ip_address = p_ip_address
    AND attempted_at > NOW() - (p_lockout_minutes || ' minutes')::INTERVAL;

  IF attempt_count >= p_max_attempts THEN
    minutes_remaining := GREATEST(
      0,
      p_lockout_minutes - EXTRACT(EPOCH FROM (NOW() - oldest_relevant))::INTEGER / 60
    );
    RETURN jsonb_build_object('locked', true, 'remaining_minutes', minutes_remaining);
  END IF;

  RETURN jsonb_build_object('locked', false, 'remaining_minutes', 0);
END;
$$;

-- Record a failed login attempt
CREATE OR REPLACE FUNCTION record_failed_login(
  p_email TEXT,
  p_ip_address INET
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.failed_login_attempts (email, ip_address)
  VALUES (LOWER(p_email), p_ip_address);
$$;

-- Clear failed login attempts on successful login
CREATE OR REPLACE FUNCTION clear_failed_logins(
  p_email TEXT,
  p_ip_address INET
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.failed_login_attempts
  WHERE email = LOWER(p_email) AND ip_address = p_ip_address;
$$;

-- Admin function to unlock an account
CREATE OR REPLACE FUNCTION admin_unlock_account(p_email TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.failed_login_attempts WHERE email = LOWER(p_email);
$$;

-- Cleanup old failed login attempts
CREATE OR REPLACE FUNCTION cleanup_old_login_attempts(
  p_retention_hours INTEGER DEFAULT 24
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.failed_login_attempts
  WHERE attempted_at < NOW() - (p_retention_hours || ' hours')::INTERVAL;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Get lockout status for admin view
CREATE OR REPLACE FUNCTION get_locked_accounts(
  p_max_attempts INTEGER DEFAULT 5,
  p_lockout_minutes INTEGER DEFAULT 15
)
RETURNS TABLE (
  email TEXT,
  attempt_count BIGINT,
  first_attempt TIMESTAMPTZ,
  last_attempt TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT
    email,
    COUNT(*) as attempt_count,
    MIN(attempted_at) as first_attempt,
    MAX(attempted_at) as last_attempt
  FROM public.failed_login_attempts
  WHERE attempted_at > NOW() - (p_lockout_minutes || ' minutes')::INTERVAL
  GROUP BY email
  HAVING COUNT(*) >= p_max_attempts
  ORDER BY last_attempt DESC;
$$;

-- These functions are called server-side only (adminDb, which bypasses RLS).
-- Revoke execution from the request role (app_user) and PUBLIC, so only the
-- owner and the connection role behind adminDb can run them.
REVOKE EXECUTE ON FUNCTION check_account_lockout(TEXT, INET, INTEGER, INTEGER) FROM PUBLIC, app_user;
REVOKE EXECUTE ON FUNCTION record_failed_login(TEXT, INET) FROM PUBLIC, app_user;
REVOKE EXECUTE ON FUNCTION clear_failed_logins(TEXT, INET) FROM PUBLIC, app_user;
REVOKE EXECUTE ON FUNCTION admin_unlock_account(TEXT) FROM PUBLIC, app_user;
REVOKE EXECUTE ON FUNCTION cleanup_old_login_attempts(INTEGER) FROM PUBLIC, app_user;
REVOKE EXECUTE ON FUNCTION get_locked_accounts(INTEGER, INTEGER) FROM PUBLIC, app_user;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

DROP TRIGGER IF EXISTS organizations_updated_at ON organizations;
CREATE TRIGGER organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS memberships_updated_at ON memberships;
CREATE TRIGGER memberships_updated_at
  BEFORE UPDATE ON memberships
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_customers_updated_at ON customers;
CREATE TRIGGER update_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS notifications_updated_at ON notifications;
CREATE TRIGGER notifications_updated_at
  BEFORE UPDATE ON notifications
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS app_settings_updated_at ON app_settings;
CREATE TRIGGER app_settings_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
