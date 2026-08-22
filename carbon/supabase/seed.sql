-- Seed data for development
-- This file is optional and can be run to populate initial test data

-- Note: In a real application, organizations and memberships should be
-- created through the application after users sign up.

-- Example: Create a demo organization (run this manually after first user signup)
-- INSERT INTO organizations (name, slug, plan)
-- VALUES ('Demo Organization', 'demo-org', 'FREE');

-- Then add the first user as owner:
-- INSERT INTO memberships (user_id, organization_id, role)
-- SELECT
--   auth.uid(),
--   (SELECT id FROM organizations WHERE slug = 'demo-org'),
--   'OWNER';
