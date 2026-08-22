-- Theme Settings Migration
-- Adds the app_theme key to app_settings and allows public read access.

-- Insert default theme (empty object = use CSS defaults)
INSERT INTO app_settings (key, value)
VALUES ('app_theme', '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Allow public read so all users get the custom theme on page load
DROP POLICY IF EXISTS "Public can read whitelisted settings" ON app_settings;
CREATE POLICY "Public can read whitelisted settings"
  ON app_settings FOR SELECT
  USING (key IN ('mfa_enabled', 'app_theme'));
