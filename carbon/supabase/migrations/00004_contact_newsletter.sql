-- =============================================================================
-- Contact form submissions + Newsletter subscribers
-- =============================================================================

-- ========== CONTACT SUBMISSIONS ==========

CREATE TABLE IF NOT EXISTS public.contact_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread', -- unread, read, replied, archived
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_submissions_status ON public.contact_submissions (status);
CREATE INDEX IF NOT EXISTS idx_contact_submissions_created_at ON public.contact_submissions (created_at DESC);

ALTER TABLE public.contact_submissions ENABLE ROW LEVEL SECURITY;

-- Only super admins can read/manage contact submissions
DROP POLICY IF EXISTS "Super admins can manage contact submissions" ON public.contact_submissions;
CREATE POLICY "Super admins can manage contact submissions"
  ON public.contact_submissions FOR ALL
  USING (public.is_super_admin());

-- SECURITY: No direct-client (anon/authenticated) write policy exists on this
-- table. The public contact form POSTs to /api/v1/newsletter/../contact, which
-- writes via the server's service_role client (BYPASSRLS) — see
-- routes/v1/contact.ts. A permissive `WITH CHECK (true)` INSERT policy would let
-- ANY logged-in user (authenticated holds table INSERT grant, roles.sql) inject
-- rows straight into PostgREST with no legitimate purpose. The DROP below is kept
-- (without a matching CREATE) so re-applying this migration scrubs any
-- previously-created permissive policy.
DROP POLICY IF EXISTS "Anyone can submit contact form" ON public.contact_submissions;

DROP TRIGGER IF EXISTS update_contact_submissions_updated_at ON public.contact_submissions;
CREATE TRIGGER update_contact_submissions_updated_at
  BEFORE UPDATE ON public.contact_submissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ========== NEWSLETTER SUBSCRIBERS ==========

CREATE TABLE IF NOT EXISTS public.newsletter_subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, active, unsubscribed
  confirmation_token UUID DEFAULT gen_random_uuid(),
  subscribed_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_status ON public.newsletter_subscribers (status);
-- email is UNIQUE (see column def), which already creates an index; a separate
-- idx_ would be a duplicate.

ALTER TABLE public.newsletter_subscribers ENABLE ROW LEVEL SECURITY;

-- Only super admins can read/manage subscribers
DROP POLICY IF EXISTS "Super admins can manage newsletter subscribers" ON public.newsletter_subscribers;
CREATE POLICY "Super admins can manage newsletter subscribers"
  ON public.newsletter_subscribers FOR ALL
  USING (public.is_super_admin());

-- SECURITY: No direct-client (anon/authenticated) write policy exists on this
-- table. The ENTIRE newsletter lifecycle is server-mediated via the service_role
-- client (BYPASSRLS) in routes/v1/newsletter.ts:
--   - subscribe  -> adminDb.upsert(...)   (double opt-in, server-set token)
--   - confirm    -> adminDb.update(...).eq('confirmation_token', token)
--   - unsubscribe-> adminDb.update(...).eq('email', email)
-- The previous `FOR UPDATE USING (true) WITH CHECK (true)` policy was
-- world-writable: because `authenticated` holds a table-level UPDATE grant
-- (roles.sql), any logged-in user could PATCH /rest/v1/newsletter_subscribers
-- directly and blind-overwrite EVERY subscriber row (status, email, token).
-- The previous `FOR INSERT WITH CHECK (true)` policy was equally unscoped and let
-- anyone inject rows / bypass double opt-in — with no legitimate use, since real
-- signups insert via service_role. Both are removed. The DROPs are kept (without
-- matching CREATEs) so re-applying this migration scrubs any previously-created
-- permissive policy. Legitimate access remains: service_role (server) bypasses
-- RLS; super admins use the "Super admins can manage" policy above.
DROP POLICY IF EXISTS "Anyone can subscribe to newsletter" ON public.newsletter_subscribers;
DROP POLICY IF EXISTS "Anyone can confirm or unsubscribe" ON public.newsletter_subscribers;

DROP TRIGGER IF EXISTS update_newsletter_subscribers_updated_at ON public.newsletter_subscribers;
CREATE TRIGGER update_newsletter_subscribers_updated_at
  BEFORE UPDATE ON public.newsletter_subscribers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
