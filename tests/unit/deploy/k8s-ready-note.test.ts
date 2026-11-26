/**
 * The note a k8s deploy ends with (k8sReadyNoteLines) points at the
 * kubeconfig files the deploy wrote: one for a single cluster, and on k8s-ha
 * one per side, named for each side's stack (fetchKubeconfig), since a
 * k8s-ha deploy writes no kubeconfig-<env>. Its CI/CD line says what
 * `configure cicd <env>` does now: Flux pulls the repo from inside the
 * cluster, and no GitHub Actions run deploys.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { k8sReadyNoteLines } from '../../../src/lib/deploy/orchestrator.js';

const projectDir = '/project';
const kubeconfig = (stack: string) => join(projectDir, '.vibecarbon', `kubeconfig-${stack}`);

describe('the k8s deploy note', () => {
  it('a single cluster names its one kubeconfig', () => {
    const lines = k8sReadyNoteLines({
      projectDir,
      environment: 'prod',
      ha: false,
      masterIp: '192.0.2.1',
    });
    expect(lines.filter((l) => l.includes('kubeconfig-'))).toEqual([
      `Kubeconfig:  ${kubeconfig('prod')}`,
    ]);
    expect(lines).toContain('Master IP:   192.0.2.1');
  });

  it("k8s-ha names each side's kubeconfig, never kubeconfig-<env>", () => {
    const lines = k8sReadyNoteLines({
      projectDir,
      environment: 'prod',
      ha: true,
      masterIp: '192.0.2.1',
    });
    expect(lines.filter((l) => l.includes('kubeconfig-'))).toEqual([
      `Kubeconfig:  ${kubeconfig('prod-primary')}`,
      `             ${kubeconfig('prod-standby')}`,
    ]);
    expect(lines.join('\n')).not.toMatch(/kubeconfig-prod(?![-\w])/);
  });

  it('the CI/CD line says Flux pulls, and nothing about GitHub Actions deploying', () => {
    for (const ha of [false, true]) {
      const lines = k8sReadyNoteLines({ projectDir, environment: 'prod', ha, masterIp: null });
      const at = lines.indexOf('  vibecarbon configure cicd prod');
      expect(at, String(ha)).toBeGreaterThan(0);
      expect(lines[at - 1]).toBe(
        `# To let Flux pull your repo into ${ha ? 'both clusters' : 'the cluster'}:`,
      );
      expect(lines.join('\n')).not.toMatch(/GitHub Actions/);
    }
  });
});
