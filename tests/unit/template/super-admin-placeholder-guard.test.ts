import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the dev `db:migrate` crash:
 *   ERROR: duplicate key value violates unique constraint "users_phone_key"
 *
 * In the carbon-in-place dev workflow, /tmp/super-admin.sql is the raw template
 * (super-admin.dev.sql) with an UNREPLACED {{ADMIN_EMAIL}} token. The existence
 * check `WHERE email = admin_email` can never match that literal, so the seed
 * always attempts an INSERT and collides on UNIQUE(phone) with the real admin
 * created at container init. The DO block must refuse to run when the email is
 * still a "{{...}}" placeholder.
 */
const CARBON = join(process.cwd(), 'carbon');
const FILES = ['volumes/db/super-admin.sql', 'volumes/db/super-admin.dev.sql'];

describe('super-admin seed refuses unreplaced placeholders', () => {
  for (const f of FILES) {
    it(`${f} guards against an unreplaced {{ADMIN_EMAIL}} placeholder`, () => {
      const sql = readFileSync(join(CARBON, f), 'utf-8');
      const guard = sql.match(/IF admin_email IS NOT NULL[^\n]*THEN/);
      expect(guard, 'guard line present').not.toBeNull();
      expect(guard?.[0]).toContain("NOT LIKE '{{%'");
    });
  }
});
