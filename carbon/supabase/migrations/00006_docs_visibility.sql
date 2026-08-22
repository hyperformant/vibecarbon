-- Documentation visibility toggles
--
-- Not every project ships user-facing documentation, and not every project
-- wants its API surface advertised. These two runtime settings let a super
-- admin turn either off from the admin Settings UI without redeploying.
--
-- `user_docs_enabled` governs the MDX docs site (/docs, /docs/:slug) and
-- every link that points at it (nav, footer, hero CTA, FAQ, pricing CTA,
-- dashboard quick action, setup guide links).
--
-- `api_docs_enabled` governs the whole API documentation surface as one
-- unit: the Scalar reference at /api/docs, the raw spec at
-- /api/openapi.json, and the dev-only Swagger UI at /api/swagger. These
-- travel together because the spec is what the other two render — leaving
-- it served while hiding the viewers would not actually take the API
-- documentation down.
--
-- Both default to true so existing installs keep their current behavior.

INSERT INTO app_settings (key, value)
VALUES
  ('user_docs_enabled', '{"enabled": true}'::jsonb),
  ('api_docs_enabled', '{"enabled": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Public read so unauthenticated marketing pages can decide whether to
-- render docs links before login (mirrors mfa_enabled / app_theme /
-- localization_enabled / enabled_languages).
DROP POLICY IF EXISTS "Public can read whitelisted settings" ON app_settings;
CREATE POLICY "Public can read whitelisted settings"
  ON app_settings FOR SELECT
  USING (key IN (
    'mfa_enabled',
    'app_theme',
    'localization_enabled',
    'enabled_languages',
    'user_docs_enabled',
    'api_docs_enabled'
  ));
