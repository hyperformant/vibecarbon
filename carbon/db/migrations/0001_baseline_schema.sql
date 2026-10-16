CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'unread' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crawler_hits" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "crawler_hits_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"crawler" text NOT NULL,
	"path" text NOT NULL,
	"user_agent" text,
	"hit_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" smallint
);
--> statement-breakpoint
ALTER TABLE "crawler_hits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crawler_hits_daily" (
	"day" date NOT NULL,
	"crawler" text NOT NULL,
	"path" text NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "crawler_hits_daily_pkey" PRIMARY KEY("day","crawler","path")
);
--> statement-breakpoint
ALTER TABLE "crawler_hits_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cron_job_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"result" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cron_job_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"stripe_customer_id" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_stripe_customer_id_key" UNIQUE("stripe_customer_id"),
	CONSTRAINT "customer_type" CHECK ((user_id IS NOT NULL AND organization_id IS NULL) OR
    (user_id IS NULL AND organization_id IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "failed_login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"ip_address" "inet" NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "failed_login_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" text DEFAULT 'MEMBER',
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_id_organization_id_key" UNIQUE("user_id","organization_id"),
	CONSTRAINT "memberships_role_check" CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER'))
);
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "newsletter_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirmation_token" uuid DEFAULT gen_random_uuid(),
	"subscribed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "newsletter_subscribers_email_key" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notification_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_dismissals_notification_id_user_id_key" UNIQUE("notification_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "notification_dismissals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"message" text,
	"type" text DEFAULT 'info',
	"visibility" text DEFAULT 'all',
	"dismissible" boolean DEFAULT true,
	"organization_id" uuid,
	"starts_at" timestamp with time zone DEFAULT now(),
	"ends_at" timestamp with time zone,
	"action_label" text,
	"action_url" text,
	"is_active" boolean DEFAULT true,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_type_check" CHECK (type IN ('info', 'warning', 'error', 'success')),
	CONSTRAINT "notifications_visibility_check" CHECK (visibility IN ('all', 'authenticated', 'public'))
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" text DEFAULT 'FREE',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_key" UNIQUE("slug"),
	CONSTRAINT "organizations_plan_check" CHECK (plan IN ('FREE', 'STARTER', 'PRO', 'ENTERPRISE'))
);
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"impersonated_by" uuid,
	"two_factor_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_key" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"status" text NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_stripe_subscription_id_key" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "subscriptions_status_check" CHECK (status IN ('active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'trialing', 'unpaid', 'paused'))
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" uuid NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "two_factor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"two_factor_enabled" boolean DEFAULT false,
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_key" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_dismissals" ADD CONSTRAINT "notification_dismissals_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_dismissals" ADD CONSTRAINT "notification_dismissals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_impersonated_by_fkey" FOREIGN KEY ("impersonated_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_user_id" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_app_settings_updated_by" ON "app_settings" USING btree ("updated_by") WHERE updated_by IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_contact_submissions_status" ON "contact_submissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_contact_submissions_created_at" ON "contact_submissions" USING btree ("created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_crawler_hits_hit_at" ON "crawler_hits" USING btree ("hit_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_crawler_hits_crawler_hit_at" ON "crawler_hits" USING btree ("crawler","hit_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_crawler_hits_daily_crawler_day" ON "crawler_hits_daily" USING btree ("crawler","day" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_cron_job_history_job_name" ON "cron_job_history" USING btree ("job_name");--> statement-breakpoint
CREATE INDEX "idx_cron_job_history_started_at" ON "cron_job_history" USING btree ("started_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_customers_user_id" ON "customers" USING btree ("user_id") WHERE user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_customers_organization_id" ON "customers" USING btree ("organization_id") WHERE organization_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_failed_login_attempts_lookup" ON "failed_login_attempts" USING btree ("email","ip_address","attempted_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_failed_login_attempts_time" ON "failed_login_attempts" USING btree ("attempted_at");--> statement-breakpoint
CREATE INDEX "idx_memberships_user_id" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_memberships_organization_id" ON "memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_newsletter_subscribers_status" ON "newsletter_subscribers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_notification_dismissals_user" ON "notification_dismissals" USING btree ("user_id","notification_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_active" ON "notifications" USING btree ("is_active","starts_at","ends_at") WHERE is_active = true;--> statement-breakpoint
CREATE INDEX "idx_notifications_org" ON "notifications" USING btree ("organization_id") WHERE organization_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_notifications_created_by" ON "notifications" USING btree ("created_by") WHERE created_by IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_session_user_id" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_session_impersonated_by" ON "session" USING btree ("impersonated_by") WHERE impersonated_by IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_subscriptions_customer_id" ON "subscriptions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_status" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_two_factor_secret" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "idx_two_factor_user_id" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_verification_identifier" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE POLICY "Public can read whitelisted settings" ON "app_settings" AS PERMISSIVE FOR SELECT TO public USING (key IN (
    'mfa_enabled',
    'app_theme',
    'user_docs_enabled',
    'api_docs_enabled'
  ));--> statement-breakpoint
CREATE POLICY "Super admins can read all settings" ON "app_settings" AS PERMISSIVE FOR SELECT TO public USING (is_super_admin());--> statement-breakpoint
CREATE POLICY "Super admins can update app settings" ON "app_settings" AS PERMISSIVE FOR UPDATE TO public USING (is_super_admin()) WITH CHECK (is_super_admin());--> statement-breakpoint
CREATE POLICY "Super admins can insert app settings" ON "app_settings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (is_super_admin());--> statement-breakpoint
CREATE POLICY "Super admins can manage contact submissions" ON "contact_submissions" AS PERMISSIVE FOR ALL TO public USING (is_super_admin());--> statement-breakpoint
CREATE POLICY "Super admins can read crawler hits" ON "crawler_hits" AS PERMISSIVE FOR SELECT TO public USING (is_super_admin());--> statement-breakpoint
CREATE POLICY "Super admins can read crawler hit rollups" ON "crawler_hits_daily" AS PERMISSIVE FOR SELECT TO public USING (is_super_admin());--> statement-breakpoint
CREATE POLICY "Super admins can read job history" ON "cron_job_history" AS PERMISSIVE FOR SELECT TO public USING (is_super_admin());--> statement-breakpoint
CREATE POLICY "Users can view their own customer records" ON "customers" AS PERMISSIVE FOR SELECT TO public USING (user_id = (SELECT app.user_id()) OR
    organization_id IN (SELECT get_user_org_ids()));--> statement-breakpoint
CREATE POLICY "Users can view memberships in their organizations" ON "memberships" AS PERMISSIVE FOR SELECT TO public USING (organization_id IN (SELECT get_user_org_ids()));--> statement-breakpoint
CREATE POLICY "Admins can add non-owner members" ON "memberships" AS PERMISSIVE FOR INSERT TO public WITH CHECK (organization_id IN (SELECT get_user_admin_org_ids())
    AND role IN ('ADMIN', 'MEMBER'));--> statement-breakpoint
CREATE POLICY "Owners can add any member" ON "memberships" AS PERMISSIVE FOR INSERT TO public WITH CHECK (organization_id IN (SELECT get_user_owner_org_ids()));--> statement-breakpoint
CREATE POLICY "Admins can update non-owner memberships" ON "memberships" AS PERMISSIVE FOR UPDATE TO public USING (organization_id IN (SELECT get_user_admin_org_ids())
    AND role <> 'OWNER') WITH CHECK (organization_id IN (SELECT get_user_admin_org_ids())
    AND role <> 'OWNER');--> statement-breakpoint
CREATE POLICY "Owners can update any membership" ON "memberships" AS PERMISSIVE FOR UPDATE TO public USING (organization_id IN (SELECT get_user_owner_org_ids())) WITH CHECK (organization_id IN (SELECT get_user_owner_org_ids()));--> statement-breakpoint
CREATE POLICY "Users can leave or be removed by owners/admins" ON "memberships" AS PERMISSIVE FOR DELETE TO public USING (user_id = (SELECT app.user_id())
    OR organization_id IN (SELECT get_user_admin_org_ids()));--> statement-breakpoint
CREATE POLICY "Super admins can manage newsletter subscribers" ON "newsletter_subscribers" AS PERMISSIVE FOR ALL TO public USING (is_super_admin());--> statement-breakpoint
CREATE POLICY "Users can view their dismissals" ON "notification_dismissals" AS PERMISSIVE FOR SELECT TO public USING (user_id = (SELECT app.user_id()));--> statement-breakpoint
CREATE POLICY "Users can dismiss notifications" ON "notification_dismissals" AS PERMISSIVE FOR INSERT TO public WITH CHECK (user_id = (SELECT app.user_id()));--> statement-breakpoint
CREATE POLICY "Users can remove their dismissals" ON "notification_dismissals" AS PERMISSIVE FOR DELETE TO public USING (user_id = (SELECT app.user_id()));--> statement-breakpoint
CREATE POLICY "Authenticated users can view relevant notifications" ON "notifications" AS PERMISSIVE FOR SELECT TO "app_user" USING ((SELECT app.user_id()) IS NOT NULL
    AND is_active = true
    AND (starts_at IS NULL OR starts_at <= NOW())
    AND (ends_at IS NULL OR ends_at > NOW())
    AND (visibility IN ('all', 'authenticated'))
    AND (
      organization_id IS NULL
      OR organization_id IN (SELECT get_user_org_ids())
    ));--> statement-breakpoint
CREATE POLICY "Anonymous users can view public notifications" ON "notifications" AS PERMISSIVE FOR SELECT TO "app_user" USING ((SELECT app.user_id()) IS NULL
    AND is_active = true
    AND (starts_at IS NULL OR starts_at <= NOW())
    AND (ends_at IS NULL OR ends_at > NOW())
    AND (visibility IN ('all', 'public'))
    AND organization_id IS NULL);--> statement-breakpoint
CREATE POLICY "Super admins can create notifications" ON "notifications" AS PERMISSIVE FOR INSERT TO public WITH CHECK (is_super_admin());--> statement-breakpoint
CREATE POLICY "Super admins can update notifications" ON "notifications" AS PERMISSIVE FOR UPDATE TO public USING (is_super_admin()) WITH CHECK (is_super_admin());--> statement-breakpoint
CREATE POLICY "Super admins can delete notifications" ON "notifications" AS PERMISSIVE FOR DELETE TO public USING (is_super_admin());--> statement-breakpoint
CREATE POLICY "Users can view their organizations" ON "organizations" AS PERMISSIVE FOR SELECT TO public USING (id IN (SELECT get_user_org_ids()));--> statement-breakpoint
CREATE POLICY "Authenticated users can create organizations" ON "organizations" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((SELECT app.user_id()) IS NOT NULL);--> statement-breakpoint
CREATE POLICY "Owners and admins can update organizations" ON "organizations" AS PERMISSIVE FOR UPDATE TO public USING (id IN (SELECT get_user_admin_org_ids())) WITH CHECK (id IN (SELECT get_user_admin_org_ids()));--> statement-breakpoint
CREATE POLICY "Owners can delete organizations" ON "organizations" AS PERMISSIVE FOR DELETE TO public USING (id IN (SELECT get_user_owner_org_ids()));--> statement-breakpoint
CREATE POLICY "Users can view their own subscriptions" ON "subscriptions" AS PERMISSIVE FOR SELECT TO public USING (customer_id IN (SELECT get_user_customer_ids()));