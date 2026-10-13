/**
 * The template's RLS proof (carbon/tests/db) only means something if it runs.
 * Its suites skip themselves without TEST_DB_HOST, so a CI job that loses the
 * env var, the migrations, or the database goes green while proving nothing.
 * This pins the `template-db` job in test.yml to the steps carbon/TESTING.md
 * documents, and keeps it secret-free so it runs on fork and Dependabot PRs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf-8');

type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string> };
type Job = {
  defaults?: { run?: { 'working-directory'?: string } };
  env?: Record<string, string>;
  steps?: Step[];
};

const workflow = loadYaml(read('.github', 'workflows', 'test.yml')) as {
  jobs: Record<string, Job>;
};
const job = workflow.jobs['template-db'];
const runs = (job?.steps ?? []).flatMap((s) => (s.run ? [s.run] : []));
const indexOfRun = (needle: string) => runs.findIndex((r) => r.includes(needle));

describe('test.yml template-db job', () => {
  it('exists and runs inside carbon/', () => {
    expect(job).toBeDefined();
    expect(job.defaults?.run?.['working-directory']).toBe('carbon');
  });

  it('starts db + auth, migrates, then runs the db tier, in that order', () => {
    const up = indexOfRun('up -d --wait db auth');
    const migrate = indexOfRun('npm run db:migrate');
    const test = indexOfRun('npm run test:db');
    expect(indexOfRun('node scripts/dev-init.js')).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThanOrEqual(0);
    expect(migrate).toBeGreaterThan(up);
    expect(test).toBeGreaterThan(migrate);
  });

  it('points the db tier at the database, with the password dev-init writes', () => {
    const step = job.steps?.find((s) => s.run?.includes('npm run test:db'));
    expect(step?.env?.TEST_DB_HOST).toBe('localhost');
    const devPassword = /DB_PASSWORD: '([^']+)'/.exec(
      read('carbon', 'scripts', 'dev-init.js'),
    )?.[1];
    expect(devPassword).toBeTruthy();
    expect(step?.env?.TEST_DB_PASSWORD).toBe(devPassword);
  });

  it('uses the compose files carbon/TESTING.md documents', () => {
    const files = job.env?.COMPOSE_FILES ?? '';
    const testing = read('carbon', 'TESTING.md');
    for (const f of [
      'docker-compose.yml',
      'docker-compose.override.yml',
      'docker-compose.dev-init.yml',
    ]) {
      expect(files).toContain(`-f ${f}`);
      expect(testing).toContain(`-f ${f}`);
    }
  });

  it('needs no secrets, so it runs on every PR', () => {
    expect(JSON.stringify(job)).not.toContain('secrets.');
  });

  it('tears the stack down even when the tests fail', () => {
    const teardown = job.steps?.find((s) => s.run?.includes('down -v')) as
      | (Step & { if?: string })
      | undefined;
    expect(teardown?.if).toBe('always()');
  });
});
