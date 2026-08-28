/**
 * resolveKubeconfigPath must follow the serving ROLE, not the stack NAME
 * (d4 run 7 RCA, 2026-08-28).
 *
 * Stacks are born `<env>-primary` / `<env>-standby` and keep those names for
 * life; failover swaps only the ROLE pointers (envConfig.ha.{primary,
 * standby}.stack). The health probe's ACME watchdog and the failure
 * diagnostics both key off this path — preferring the `-primary` FILE meant
 * that after a failover they inspected the DEMOTED cluster (certs all Ready,
 * nothing to repair) while the SERVING cluster's invalid order sat
 * unrepaired for the probe's whole 20-minute budget, twice (runs 5 and 7's
 * reconverge). The serving cluster is whatever stack
 * `envConfig.ha.primary.stack` names.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveKubeconfigPath } from '../../../src/lib/deploy/orchestrator.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  process.chdir('/');
});

function makeProject(files: string[]) {
  dir = mkdtempSync(join(tmpdir(), 'vc-kcfg-'));
  mkdirSync(join(dir, '.vibecarbon'), { recursive: true });
  for (const f of files) writeFileSync(join(dir, '.vibecarbon', f), 'kubeconfig');
  process.chdir(dir);
}

describe('resolveKubeconfigPath', () => {
  it('post-failover: follows ha.primary.stack to the SERVING cluster (the -standby stack)', () => {
    makeProject(['kubeconfig-d4-primary', 'kubeconfig-d4-standby']);
    const { path } = resolveKubeconfigPath('d4', {
      ha: { primary: { stack: 'd4-standby' }, standby: { stack: 'd4-primary' } },
    });
    expect(path.endsWith('kubeconfig-d4-standby')).toBe(true);
  });

  it('pre-failover: ha.primary.stack names the -primary stack — unchanged behavior', () => {
    makeProject(['kubeconfig-d4-primary', 'kubeconfig-d4-standby']);
    const { path } = resolveKubeconfigPath('d4', {
      ha: { primary: { stack: 'd4-primary' }, standby: { stack: 'd4-standby' } },
    });
    expect(path.endsWith('kubeconfig-d4-primary')).toBe(true);
  });

  it('no ha config (single k8s): resolves kubeconfig-<env>-primary then kubeconfig-<env>', () => {
    makeProject(['kubeconfig-e3']);
    const { path } = resolveKubeconfigPath('e3', {});
    expect(path.endsWith('kubeconfig-e3')).toBe(true);
  });

  it('legacy HA config without .stack falls back to the -primary file (old behavior)', () => {
    makeProject(['kubeconfig-d4-primary']);
    const { path } = resolveKubeconfigPath('d4', { ha: { primary: {} } });
    expect(path.endsWith('kubeconfig-d4-primary')).toBe(true);
  });

  it('missing everything still returns the standalone path (loud file-not-found downstream)', () => {
    makeProject([]);
    const { path } = resolveKubeconfigPath('d4', undefined);
    expect(path.endsWith('kubeconfig-d4')).toBe(true);
  });
});
