-- Retire the runtime localization settings.
--
-- Which languages an app ships is a build-time property, not a runtime one:
-- `src/client/lib/i18n.ts` bundles whatever locale files are present, so the
-- admin toggle could only ever choose among languages already compiled in. It
-- could never add one, which is the operation people actually wanted. That
-- made the setting a second source of truth for a question the bundle had
-- already answered.
--
-- The language set now follows the locale files on disk, and the switcher
-- hides itself when there is only one. Adding a language is a code change and
-- a deploy, which is what it always was in substance.
--
-- Supersedes the runtime half of 00005_localization_languages.sql.

DELETE FROM app_settings WHERE key IN ('localization_enabled', 'enabled_languages');

-- Drop both keys from the public-read whitelist. Nothing reads them now, and
-- leaving them readable would invite a reader to think they still do something.
DROP POLICY IF EXISTS "Public can read whitelisted settings" ON app_settings;
CREATE POLICY "Public can read whitelisted settings"
  ON app_settings FOR SELECT
  USING (key IN (
    'mfa_enabled',
    'app_theme',
    'user_docs_enabled',
    'api_docs_enabled'
  ));
