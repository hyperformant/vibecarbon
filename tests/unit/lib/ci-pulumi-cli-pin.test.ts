/**
 * The integration job installs the pulumi CLI for the real-engine state test
 * (tests/integration/iac/server-state-follows-scale.test.ts), pinned to the
 * @pulumi/pulumi SDK version the lockfile installed: no second version
 * literal to drift, and never "latest".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf-8');

/** The `integration:` job's text, up to the next top-level job. */
function job(name: string) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('CI installs a pinned pulumi CLI for the integration tier', () => {
  const integration = job('integration');

  it('installs it before the integration tests run', () => {
    const install = integration.indexOf('name: Install Pulumi CLI');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(integration.indexOf('pnpm test:integration'));
  });

  it('pins the version to the installed @pulumi/pulumi SDK, never latest', () => {
    expect(integration).toMatch(/require\('@pulumi\/pulumi\/package\.json'\)\.version/);
    expect(integration).toMatch(/get\.pulumi\.com \| sh -s -- --version "\$version"/);
  });

  it('the real-engine test fails, never skips, under CI', () => {
    const test = readFileSync(
      join(ROOT, 'tests/integration/iac/server-state-follows-scale.test.ts'),
      'utf-8',
    );
    expect(test).toMatch(/describe\.skipIf\(!hasPulumi && !process\.env\.CI\)/);
    expect(test).toMatch(/expect\(hasPulumi,/);
  });
});
