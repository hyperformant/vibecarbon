import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyTemplate, generateEnvLocal, generateReadme } from '../../../src/create.js';
import { cleanupTempDir, createTempDir } from '../../_shared/temp-dir.js';

const TEMPLATE_DIR = resolve(import.meta.dirname, '../../../carbon');

describe('Project Scaffolding Integration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('scaffolding-');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe('copyTemplate', () => {
    it('copies template file to destination', () => {
      const destPath = join(tempDir, 'package.json');
      const variables = {
        PROJECT_NAME: 'test-project',
        DB_PASSWORD: 'test-password',
        JWT_SECRET: 'test-jwt-secret',
        ANON_KEY: 'test-anon-key',
        SERVICE_ROLE_KEY: 'test-service-role-key',
      };

      const result = copyTemplate('package.json', destPath, variables);

      expect(result).toBe(true);
      expect(existsSync(destPath)).toBe(true);

      const content = readFileSync(destPath, 'utf-8');
      expect(content).not.toContain('{{PROJECT_NAME}}');
    });

    it('creates parent directories', () => {
      const destPath = join(tempDir, 'deep/nested/dir/package.json');
      const variables = { PROJECT_NAME: 'test' };

      copyTemplate('package.json', destPath, variables);

      expect(existsSync(destPath)).toBe(true);
    });

    it('returns false for missing template', () => {
      const destPath = join(tempDir, 'nonexistent.txt');
      const result = copyTemplate('nonexistent-template.txt', destPath, {});
      expect(result).toBe(false);
    });
  });

  describe('generateEnvLocal', () => {
    it('generates .env.local content', () => {
      const variables = {
        ANON_KEY: 'test-anon-key',
        SERVICE_ROLE_KEY: 'test-service-role-key',
        JWT_SECRET: 'test-jwt-secret',
        DB_PASSWORD: 'test-db-password',
        ADMIN_EMAIL: 'test@example.com',
        ADMIN_PASSWORD: 'test-admin-password',
      };

      const content = generateEnvLocal('test-project', variables);

      expect(content).toContain('SUPABASE_URL="http://localhost:8000"');
      expect(content).toContain('SUPABASE_ANON_KEY="test-anon-key"');
      expect(content).toContain('SUPABASE_SERVICE_ROLE_KEY="test-service-role-key"');
      expect(content).toContain('JWT_SECRET="test-jwt-secret"');
      expect(content).toContain('DB_PASSWORD="test-db-password"');
      expect(content).toContain('ADMIN_EMAIL="test@example.com"');
      expect(content).toContain("ADMIN_PASSWORD='test-admin-password'");
    });
  });

  describe('generateReadme', () => {
    it('generates README content', () => {
      const readme = generateReadme('test-project');

      expect(readme).toContain('# test-project');
      expect(readme).toContain('Hono');
      expect(readme).toContain('React 19');
      expect(readme).toContain('Supabase');
      expect(readme).toContain('npm run dev:start');
    });
  });

  describe('Template Super Admin Role Patterns', () => {
    it('super-admin.sql uses super_admin role', () => {
      const sqlPath = join(TEMPLATE_DIR, 'volumes/db/super-admin.sql');
      const content = readFileSync(sqlPath, 'utf-8');

      // Verify the INSERT statement sets super_admin role
      expect(content).toContain("'role', 'super_admin'");
      // Verify the UPDATE statement sets super_admin role
      expect(content).toContain('{"role": "super_admin"}');
      // Should NOT contain old 'admin' role
      expect(content).not.toMatch(/'role',\s*'admin'[^_]/);
    });

    it('super-admin.dev.sql uses super_admin role', () => {
      const sqlPath = join(TEMPLATE_DIR, 'volumes/db/super-admin.dev.sql');
      const content = readFileSync(sqlPath, 'utf-8');

      // Verify the INSERT statement sets super_admin role
      expect(content).toContain("'role', 'super_admin'");
      // Verify the UPDATE statement sets super_admin role
      expect(content).toContain('{"role": "super_admin"}');
      // Should NOT contain old 'admin' role
      expect(content).not.toMatch(/'role',\s*'admin'[^_]/);
    });

    it('AuthProvider checks for super_admin role', () => {
      const authProviderPath = join(TEMPLATE_DIR, 'src/client/components/auth/AuthProvider.tsx');
      const content = readFileSync(authProviderPath, 'utf-8');

      // Verify isSuperAdmin check uses super_admin
      expect(content).toContain("user?.app_metadata?.role === 'super_admin'");
      // Should NOT check for old 'admin' role
      expect(content).not.toMatch(/app_metadata\?\.role\s*===\s*['"]admin['"]/);
    });

    it('API routes check for super_admin role', () => {
      // isSuperAdmin is in the shared auth helper
      const authPath = join(TEMPLATE_DIR, 'src/server/lib/auth.ts');
      const authContent = readFileSync(authPath, 'utf-8');

      // Verify isSuperAdmin function checks for super_admin
      expect(authContent).toContain("app_metadata?.role === 'super_admin'");
      // Should NOT check for old 'admin' role in isSuperAdmin
      expect(authContent).not.toMatch(/isSuperAdmin.*role\s*===\s*['"]admin['"]/);

      // Verify v1/index.ts imports isSuperAdmin from shared helper
      const routesPath = join(TEMPLATE_DIR, 'src/server/routes/v1/index.ts');
      const routesContent = readFileSync(routesPath, 'utf-8');
      expect(routesContent).toContain("import { isSuperAdmin } from '../../lib/auth'");
    });

    it('init migration uses super_admin in RLS', () => {
      const migrationPath = join(TEMPLATE_DIR, 'supabase/migrations/00001_init.sql');
      const content = readFileSync(migrationPath, 'utf-8');

      // Verify is_super_admin function checks for super_admin
      expect(content).toContain("= 'super_admin'");
      // Should NOT use old 'admin' role
      expect(content).not.toMatch(/=\s*['"]admin['"]\s*,/);
    });

    it('Users admin page displays super_admin badge correctly', () => {
      const usersPagePath = join(TEMPLATE_DIR, 'src/client/pages/admin/Users.tsx');
      const content = readFileSync(usersPagePath, 'utf-8');

      // Verify super_admin role check for badge display
      expect(content).toContain("user.role === 'super_admin'");
      // Should NOT check for old 'admin' role
      expect(content).not.toMatch(/user\.role\s*===\s*['"]admin['"]/);
    });
  });
});
