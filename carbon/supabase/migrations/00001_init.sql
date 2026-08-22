-- Vibecarbon Initial Migration
-- Complete database schema with multi-tenancy, billing, notifications, security, and storage
--
-- Tables:
--   - organizations: Multi-tenant organization management
--   - memberships: User-organization relationships
--   - customers: Stripe billing customers
--   - subscriptions: Stripe subscriptions
--   - notifications: System-wide notifications (with visibility controls)
--   - notification_dismissals: User dismissal tracking
--   - failed_login_attempts: Brute force protection
--   - app_settings: Global application settings
--
-- Storage Buckets:
--   - avatars: Public bucket for user profile pictures (2MB, images only)
--   - uploads: Private bucket for general file uploads (10MB)

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
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
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
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
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
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_active
  ON notifications(is_active, starts_at, ends_at)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_notifications_org
  ON notifications(organization_id)
  WHERE organization_id IS NOT NULL;

-- Covering index for the created_by FK (avoids seq scans on auth.users deletes).
CREATE INDEX IF NOT EXISTS idx_notifications_created_by
  ON notifications(created_by)
  WHERE created_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_dismissals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
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
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Covering index for the updated_by FK (avoids seq scans on auth.users deletes).
CREATE INDEX IF NOT EXISTS idx_app_settings_updated_by
  ON app_settings(updated_by)
  WHERE updated_by IS NOT NULL;

-- WARNING: This table is publicly readable by the anonymous role to support
-- pre-authentication flows (e.g. checking if MFA is enforced).
-- DO NOT STORE SECRETS, TOKENS, OR SENSITIVE ENVIRONMENT VARIABLES HERE.
-- Public access is strictly controlled via RLS policy below.

-- Grant access to anon since we removed the default global grant
GRANT SELECT ON app_settings TO anon;

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
  SELECT organization_id FROM public.memberships WHERE user_id = auth.uid();
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
  WHERE user_id = auth.uid() AND role IN ('OWNER', 'ADMIN');
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
  WHERE user_id = auth.uid() AND role = 'OWNER';
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
  WHERE c.user_id = (SELECT auth.uid())
  UNION
  SELECT c.id FROM public.customers c
  WHERE c.organization_id IN (SELECT public.get_user_org_ids());
$$;

-- Check if user is a super admin
CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin',
    false
  );
$$;

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
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL);

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
    user_id = (SELECT auth.uid())
    OR organization_id IN (SELECT get_user_admin_org_ids())
  );

-- ============================================================================
-- CUSTOMERS POLICIES (Billing)
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own customer records" ON customers;
CREATE POLICY "Users can view their own customer records"
  ON customers FOR SELECT
  USING (
    user_id = (SELECT auth.uid()) OR
    organization_id IN (SELECT get_user_org_ids())
  );

-- No client INSERT policy on `customers`: every customer row is created
-- server-side by getOrCreateCustomer via the service-role client (which
-- bypasses RLS), exactly like `subscriptions`. A client INSERT policy here was
-- needless write surface on a billing table — it let any authenticated user
-- POST /rest/v1/customers with an arbitrary stripe_customer_id (squatting a
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

DROP POLICY IF EXISTS "Authenticated users can view relevant notifications" ON notifications;
CREATE POLICY "Authenticated users can view relevant notifications"
  ON notifications FOR SELECT
  TO authenticated
  USING (
    is_active = true
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
  TO anon
  USING (
    is_active = true
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
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can dismiss notifications" ON notification_dismissals;
CREATE POLICY "Users can dismiss notifications"
  ON notification_dismissals FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can remove their dismissals" ON notification_dismissals;
CREATE POLICY "Users can remove their dismissals"
  ON notification_dismissals FOR DELETE
  USING (user_id = (SELECT auth.uid()));

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

-- These functions are called server-side via the service role key (adminDb).
-- Revoke direct execution by end users to prevent abuse.
REVOKE EXECUTE ON FUNCTION check_account_lockout(TEXT, INET, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION record_failed_login(TEXT, INET) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION clear_failed_logins(TEXT, INET) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION admin_unlock_account(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION cleanup_old_login_attempts(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_locked_accounts(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;

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

-- ============================================================================
-- STORAGE BUCKETS
-- ============================================================================

-- Avatars bucket - public, for user profile pictures
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars',
  'avatars',
  true,
  2097152, -- 2MB
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Uploads bucket - private, for general file uploads
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES (
  'uploads',
  'uploads',
  false,
  10485760 -- 10MB
)
ON CONFLICT (id) DO NOTHING;

-- RLS policies for avatars bucket
DROP POLICY IF EXISTS "Anyone can view avatars" ON storage.objects;
CREATE POLICY "Anyone can view avatars"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Users can upload their own avatar" ON storage.objects;
CREATE POLICY "Users can upload their own avatar"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'avatars'
    AND (SELECT auth.uid())::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users can update their own avatar" ON storage.objects;
CREATE POLICY "Users can update their own avatar"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'avatars'
    AND (SELECT auth.uid())::text = (storage.foldername(name))[1]
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND (SELECT auth.uid())::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users can delete their own avatar" ON storage.objects;
CREATE POLICY "Users can delete their own avatar"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'avatars'
    AND (SELECT auth.uid())::text = (storage.foldername(name))[1]
  );

-- RLS policies for uploads bucket
DROP POLICY IF EXISTS "Users can view their own uploads" ON storage.objects;
CREATE POLICY "Users can view their own uploads"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'uploads'
    AND (SELECT auth.uid())::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users can upload their own files" ON storage.objects;
CREATE POLICY "Users can upload their own files"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'uploads'
    AND (SELECT auth.uid())::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users can update their own files" ON storage.objects;
CREATE POLICY "Users can update their own files"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'uploads'
    AND (SELECT auth.uid())::text = (storage.foldername(name))[1]
  )
  WITH CHECK (
    bucket_id = 'uploads'
    AND (SELECT auth.uid())::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users can delete their own files" ON storage.objects;
CREATE POLICY "Users can delete their own files"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'uploads'
    AND (SELECT auth.uid())::text = (storage.foldername(name))[1]
  );
