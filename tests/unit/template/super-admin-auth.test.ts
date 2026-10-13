import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The platform super admin is one server-controlled column, `user.role`,
 * compared exactly. The API helper and the SQL helper must agree, and the
 * server must not keep a second, looser definition anywhere.
 *
 * Behavior of the real helper (every near-miss role) is tested in
 * carbon/tests/unit/server/is-super-admin.test.ts; this file pins the
 * source so a drift between the two definitions fails here.
 */

const ROOT = process.cwd();
const SERVER = join(ROOT, 'carbon/src/server');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

function serverFiles(dir = SERVER): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...serverFiles(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('isSuperAdmin (carbon/src/server/lib/auth.ts)', () => {
  const src = read('carbon/src/server/lib/auth.ts');

  it('is an exact match on user.role, like SQL is_super_admin()', () => {
    expect(src).toContain("return user.role === 'super_admin';");
    const sql = read('carbon/supabase/migrations/00001_init.sql');
    expect(sql).toMatch(/u\.role = 'super_admin'/);
  });

  it('never reads metadata or accepts a looser role', () => {
    expect(src).not.toMatch(/app_metadata|user_metadata/);
    expect(src).not.toMatch(/toLowerCase|includes\(|startsWith\(/);
    expect(src).not.toMatch(/role\s*===\s*['"]admin['"]/);
  });
});

describe('server role checks go through isSuperAdmin', () => {
  // Files that still compare a role from the old auth service's admin API
  // (a looked-up target user, not the caller). They move to the in-process
  // auth with the admin-surface rewrite.
  const LEGACY_TARGET_LOOKUPS = new Set(['routes/v1/impersonation.ts']);

  it("no server file compares the caller's role inline", () => {
    const offenders = serverFiles()
      .map((path) => ({ rel: relative(SERVER, path), text: readFileSync(path, 'utf-8') }))
      .filter((f) => f.rel !== 'lib/auth.ts' && !LEGACY_TARGET_LOOKUPS.has(f.rel))
      .filter((f) => /\.role\s*[!=]==?\s*['"]super_admin['"]/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
