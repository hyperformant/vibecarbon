/**
 * The template's migrations census (carbon/tests/structural/
 * template-migrations-census.test.ts) pins carbon/db/migrations to its one
 * baseline set. A generated project's history grows with every
 * `drizzle-kit generate`, so the census must never reach a project:
 * `vibecarbon create` leaves it out of the tests copy, and `upgrade` never
 * writes tests/** (upgrade-policy.test.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEMPLATE_ONLY_TESTS } from '../../../src/create.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

describe('template-only tests', () => {
  it('lists the migrations census, and it exists in the template', () => {
    expect(TEMPLATE_ONLY_TESTS).toContain('template-migrations-census.test.ts');
    for (const name of TEMPLATE_ONLY_TESTS) {
      expect(existsSync(join(ROOT, 'carbon', 'tests', 'structural', name)), name).toBe(true);
    }
  });

  it('create copies tests/ without them', () => {
    const src = readFileSync(join(ROOT, 'src', 'create.js'), 'utf8');
    expect(src).toMatch(
      /copyTemplateDir\('tests', join\(projectDir, 'tests'\), variables, TEMPLATE_ONLY_TESTS\)/,
    );
  });

  it('the drift check (valid for any history) does ship', () => {
    expect(TEMPLATE_ONLY_TESTS).not.toContain('migrations-drift.test.ts');
  });
});
