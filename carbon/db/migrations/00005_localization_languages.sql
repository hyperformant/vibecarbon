-- Localization: enabled languages
--
-- Promotes the language list from a build-time env var
-- (VITE_ENABLED_LANGUAGES) to a runtime DB-backed setting so admins can
-- swap languages from the admin Settings UI without redeploying.
--
-- The on/off master switch (`localization_enabled`) was added earlier.
-- This adds the companion list of which languages the switcher should
-- offer when it's on. With <2 codes the switcher auto-hides at the
-- component level (LanguageSwitcher.tsx), so a single-language project
-- has no visible switcher even with localization_enabled=true.

INSERT INTO app_settings (key, value)
VALUES ('enabled_languages', '{"codes": ["en"]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Public read so unauthenticated nav can render the right switcher
-- options before login (mirrors mfa_enabled / app_theme / localization_enabled).
DROP POLICY IF EXISTS "Public can read whitelisted settings" ON app_settings;
CREATE POLICY "Public can read whitelisted settings"
  ON app_settings FOR SELECT
  USING (key IN ('mfa_enabled', 'app_theme', 'localization_enabled', 'enabled_languages'));
