import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the production DB connection budget and the database's network
 * exposure against silent drift. Raw-text assertions (the repo has no YAML
 * parser dep) over the template's compose files. Not a runtime check.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..');
const base = readFileSync(join(REPO_ROOT, 'carbon/docker-compose.yml'), 'utf-8');
const prod = readFileSync(join(REPO_ROOT, 'carbon/docker-compose.prod.yml'), 'utf-8');

describe('DB connection budget (carbon/docker-compose.yml)', () => {
  it('sets an explicit Postgres max_connections=200 on the db command', () => {
    expect(base).toContain('max_connections=200');
  });
});

describe('the database has no public port in production', () => {
  // Operators reach the database through `vibecarbon shell` / SSH. The only
  // host publication of 5432 is the dev override's DEV_DB_PORT, which is never
  // deployed.
  it('neither the base file nor the prod overlay publishes 5432 or 6543', () => {
    for (const [name, text] of [
      ['docker-compose.yml', base],
      ['docker-compose.prod.yml', prod],
    ]) {
      expect(text, `${name} publishes a database port`).not.toMatch(/["']?[\d.:]*(5432|6543):\d+/);
    }
  });
});
