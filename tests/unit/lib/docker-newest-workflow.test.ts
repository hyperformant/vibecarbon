/**
 * The scheduled newest-Docker workflow is the warning that a new Docker broke
 * us, so it has to keep testing what a server actually gets, and a failure has
 * to reach a person without blocking anyone. Each check here is a way it could
 * rot unnoticed: it only runs on a schedule, and it would simply keep passing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const PATH = '.github/workflows/docker-newest.yml';

type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string> };
type Job = {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};

const text = readFileSync(PATH, 'utf-8');
const workflow = loadYaml(text) as Workflow;
const steps = workflow.jobs['newest-docker'].steps;
const script = steps.map((s) => s.run ?? '').join('\n');

describe('docker-newest workflow', () => {
  it('runs on a schedule, by hand, and as a job another workflow can call', () => {
    expect(workflow.on.schedule).toBeDefined();
    expect('workflow_dispatch' in workflow.on).toBe(true);
    expect('workflow_call' in workflow.on).toBe(true);
    expect('pull_request' in workflow.on).toBe(false);
    expect('push' in workflow.on).toBe(false);
  });

  it("installs from Docker's own apt repo, the same packages as a server, with no version", () => {
    expect(script).toContain('https://download.docker.com/linux/ubuntu');
    expect(script).toContain("from './src/lib/iac/docker-install.js'");
    expect(script).toContain('DOCKER_PACKAGES');
    expect(script).not.toMatch(/docker-ce[=:]/);
  });

  it('tests the layer delta and the socket proxy, on a server side that floats too', () => {
    const paths = script.match(/tests\/integration\/docker\/\S+\.test\.ts/g) ?? [];
    expect(paths.map((p) => p.split('/').pop())).toEqual(
      expect.arrayContaining(['layer-delta-roundtrip.test.ts', 'traefik-socket-proxy.test.ts']),
    );
    for (const path of paths) expect(existsSync(path), path).toBe(true);
    const test = steps.find((s) => s.run?.includes('layer-delta-roundtrip'));
    expect(test?.env?.DOCKER_INTEGRATION).toBe('true');
    expect(test?.env?.VC_DIND_IMAGE).toBe('docker:dind');
    expect(readFileSync('tests/integration/docker/layer-delta-roundtrip.test.ts', 'utf-8')).toMatch(
      /process\.env\.VC_DIND_IMAGE/,
    );
  });

  it('turns a scheduled failure into one issue, and holds that permission nowhere else', () => {
    const escalate = workflow.jobs.escalate;
    expect(escalate.needs).toBe('newest-docker');
    expect(escalate.if).toContain('failure()');
    expect(escalate.if).toContain("github.event_name == 'schedule'");
    expect(escalate.permissions?.issues).toBe('write');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs['newest-docker'].permissions).toBeUndefined();
  });

  it('blocks nothing: the gate on main never mentions it', () => {
    expect(readFileSync('.github/workflows/test.yml', 'utf-8')).not.toContain('docker-newest');
    expect(readFileSync('.github/workflows/release.yml', 'utf-8')).not.toContain('docker-newest');
  });
});
