/**
 * No add-on connects to the app database as the superuser.
 *
 * Metabase's "Application Data" connection and n8n's APP_DB_* credential are
 * open to anyone with Metabase's SQL editor or an n8n Postgres node. As the
 * `postgres` superuser that is `COPY ... TO PROGRAM` (a shell in the db
 * container, which holds the backup bucket's keys) and every auth table
 * (password hashes, plain-text session tokens, TOTP secrets). Each add-on
 * uses its own role instead, made NOSUPERUSER BYPASSRLS by its init script,
 * which also takes the auth tables back (carbon/tests/db/addon-init-grants.test.ts
 * proves the grants against a real database).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const ADDON_ROLES = new Set(['metabase', 'n8n']);

const FILES = execFileSync(
  'git',
  [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    'carbon/docker-compose*.yml',
    'carbon/volumes/*',
    'carbon/k8s/*',
    'services/*',
    'docs/*.md',
  ],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean);

/** Every value APP_DB_USER is given: `APP_DB_USER: x`, `- APP_DB_USER=x`, `${APP_DB_USER:-x}`, k8s `name: APP_DB_USER` + `value: x`. */
function appDbUserValues(text: string): string[] {
  const values: string[] = [];
  for (const m of text.matchAll(/APP_DB_USER\s*[:=]\s*["']?([^\s"'}#]+)/g)) values.push(m[1]);
  for (const m of text.matchAll(/\$\{APP_DB_USER:-([^}]+)\}/g)) values.push(m[1]);
  for (const m of text.matchAll(/name:\s*APP_DB_USER\s*\n\s*value:\s*["']?([\w-]+)/g))
    values.push(m[1]);
  return values;
}

describe('add-on app-database roles', () => {
  it('APP_DB_USER is never the superuser, anywhere it is set', () => {
    const seen: string[] = [];
    for (const file of FILES) {
      const text = read(file);
      for (const value of appDbUserValues(text)) {
        // `${APP_DB_USER}` / `{{$env.APP_DB_USER}}` references are not values.
        if (value.startsWith('$') || value.startsWith('{')) continue;
        seen.push(file);
        expect(ADDON_ROLES.has(value), `${file}: APP_DB_USER=${value}`).toBe(true);
      }
    }
    // Not vacuous: both add-ons' compose files and Metabase's setup default are checked.
    expect(seen).toEqual(
      expect.arrayContaining([
        'services/metabase/compose/docker-compose.yml',
        'services/metabase/scripts/setup.sh',
        'services/n8n/compose/docker-compose.yml',
        'carbon/docker-compose.metabase.yml',
      ]),
    );
  });

  it("Metabase's setup connects as metabase, and n8n's credential names n8n", () => {
    expect(read('services/metabase/scripts/setup.sh')).toMatch(
      /^APP_DB_USER="\$\{APP_DB_USER:-metabase\}"$/m,
    );
    expect(read('services/metabase/compose/docker-compose.yml')).toMatch(/APP_DB_USER: metabase$/m);
    expect(read('carbon/docker-compose.metabase.yml')).toMatch(/- APP_DB_USER=metabase$/m);
    expect(read('services/n8n/compose/docker-compose.yml')).toMatch(/- APP_DB_USER=n8n$/m);
  });

  for (const role of ADDON_ROLES) {
    it(`${role}-init.sh demotes its role, and the template copy matches the add-on's`, () => {
      const script = read(`services/${role}/db/init.sh`);
      expect(read(`carbon/volumes/db/${role}-init.sh`)).toBe(script);
      expect(script).toMatch(new RegExp(`^ALTER ROLE ${role} NOSUPERUSER BYPASSRLS;$`, 'm'));
      expect(script).not.toMatch(/\bSUPERUSER\b/);
      expect(script).toContain(`EXECUTE format('REVOKE ALL ON TABLE public.%I FROM ${role}', t)`);
    });
  }

  it("the baseline's auth-table revoke loop also reaches RLS-bypass add-on roles", () => {
    const sql = read('carbon/db/migrations/0002_baseline_post.sql');
    const loop = sql.match(
      /FOR r IN\s+SELECT rolname FROM pg_catalog\.pg_roles\s+WHERE ([^\n]*)/,
    )?.[1];
    expect(loop, 'auth-table revoke loop not found').toBeDefined();
    expect(loop).toMatch(/NOT rolsuper/);
    expect(loop).not.toMatch(/rolbypassrls/);
  });
});
