/**
 * Every CI job that runs the integration tier installs the pulumi CLI first.
 *
 * The real-engine tests under tests/integration/iac fail, rather than skip,
 * when CI has no pulumi CLI. The engines.node floor job ran them for months
 * with no install step, because the ubuntu-24.04 runner image shipped a
 * pulumi CLI. The ubuntu-26.04 image does not, so the job went red on the day
 * `ubuntu-latest` moved. A job must not depend on what the image happens to
 * carry.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

type Step = { name?: string; run?: string };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const workflow = loadYaml(
  readFileSync(join(process.cwd(), '.github/workflows/test.yml'), 'utf8'),
) as Workflow;

const RUNS_INTEGRATION = /pnpm test:integration\b/;
const INSTALLS_PULUMI = /get\.pulumi\.com/;

const integrationJobs = Object.entries(workflow.jobs).filter(([, job]) =>
  (job.steps ?? []).some((s) => RUNS_INTEGRATION.test(s.run ?? '')),
);

describe('CI jobs that run the integration tier', () => {
  it('finds the integration job and the engines.node floor job', () => {
    expect(integrationJobs.map(([id]) => id).sort()).toEqual(['engines-min', 'integration']);
  });

  it.each(integrationJobs)('%s installs the pulumi CLI before the tests run', (_id, job) => {
    const steps = job.steps ?? [];
    const install = steps.findIndex((s) => INSTALLS_PULUMI.test(s.run ?? ''));
    const tests = steps.findIndex((s) => RUNS_INTEGRATION.test(s.run ?? ''));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(tests);
  });
});
