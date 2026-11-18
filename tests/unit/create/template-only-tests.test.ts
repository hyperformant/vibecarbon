/**
 * The template's migrations census (carbon/tests/structural/
 * template-migrations-census.test.ts) pins carbon/db/migrations to its one
 * baseline set. A generated project's history grows with every
 * `drizzle-kit generate`, so the census must never reach a project:
 * `vibecarbon create` leaves it out of the tests copy, and `upgrade` never
 * writes tests/** (upgrade-policy.test.ts). That create really leaves it out
 * is asserted on a created project (tests/integration/template/create.test.ts),
 * not on create.js's source text.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEMPLATE_ONLY_TESTS } from '../../../src/create.js';
import { REPO_ROOT } from '../../_shared/source-files.js';

describe('template-only tests', () => {
  it('lists the migrations census, and it exists in the template', () => {
    expect(TEMPLATE_ONLY_TESTS).toContain('template-migrations-census.test.ts');
    const tiers = readdirSync(join(REPO_ROOT, 'carbon', 'tests'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const name of TEMPLATE_ONLY_TESTS) {
      const found = tiers.some((tier) =>
        existsSync(join(REPO_ROOT, 'carbon', 'tests', tier, name)),
      );
      expect(found, name).toBe(true);
    }
  });

  // It reads services/<addon>/db/init.sh, which exists only in this repo. In a
  // project it failed on a missing file for every add-on not installed.
  it("lists the add-on init-grants test, which reads this repo's add-on bundles", () => {
    expect(TEMPLATE_ONLY_TESTS).toContain('addon-init-grants.test.ts');
    const test = join(REPO_ROOT, 'carbon', 'tests', 'db', 'addon-init-grants.test.ts');
    expect(existsSync(test)).toBe(true);
    for (const addon of ['metabase', 'n8n']) {
      expect(existsSync(join(REPO_ROOT, 'services', addon, 'db', 'init.sh')), addon).toBe(true);
    }
  });

  it('the drift check (valid for any history) does ship', () => {
    expect(TEMPLATE_ONLY_TESTS).not.toContain('migrations-drift.test.ts');
  });
});
