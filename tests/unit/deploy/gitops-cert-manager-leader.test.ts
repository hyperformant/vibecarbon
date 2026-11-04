/**
 * The GitOps workflow waits for a settled cert-manager leader before it
 * applies the TLS Certificate, as the CLI deploy and the failover promotion
 * do (readiness.js awaitCertManagerLeader). The workflow cannot import the
 * CLI, so carbon/scripts/await-cert-manager-leader.sh judges the same objects
 * the same way: the controller rollout complete, then the lease
 * kube-system/cert-manager-controller held by a pod of the ReplicaSet at the
 * Deployment's revision. One bounded wait, then one ::error:: line.
 *
 * Driven here with a fake `kubectl` on PATH that answers from the fixture.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const SCRIPT = join(ROOT, 'carbon/scripts/await-cert-manager-leader.sh');
const WF = readFileSync(join(ROOT, 'carbon/.github/workflows/deploy.yml'), 'utf-8');

const RS = 'cert-manager-7c9f8d6b5 2\ncert-manager-5d4b8c7f9 3\n';
const NEW_HOLDER = 'cert-manager-5d4b8c7f9-x7k2p-external-cert-manager-controller';
const OLD_HOLDER = 'cert-manager-7c9f8d6b5-q9w8e-external-cert-manager-controller';

/** A fake kubectl: the lease holder switches to HOLDER_AFTER from the Nth lease read on. */
const FAKE_KUBECTL = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/calls"
case "$*" in
  *"rollout status"*) exit "\${FAKE_ROLLOUT_RC:-0}" ;;
  *"get deployment"*) printf '%s' "\${FAKE_REV-3}" ;;
  *"get replicasets"*) printf '%b' "\${FAKE_RS}" ;;
  *"get lease"*)
    if [ -n "\${FAKE_LEASE_ERR:-}" ]; then echo "$FAKE_LEASE_ERR" >&2; exit 1; fi
    n=$(grep -c 'get lease' "$FAKE_DIR/calls")
    if [ -n "\${FAKE_HOLDER_AFTER:-}" ] && [ "$n" -ge "\${FAKE_SWITCH_AT:-2}" ]; then
      printf '%s' "$FAKE_HOLDER_AFTER"
    else
      printf '%s' "\${FAKE_HOLDER:-}"
    fi ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runScript(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-cm-leader-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'kubectl'), FAKE_KUBECTL);
  chmodSync(join(dir, 'kubectl'), 0o755);
  writeFileSync(join(dir, 'calls'), '');
  const res = spawnSync('bash', [SCRIPT], {
    encoding: 'utf-8',
    timeout: 20_000,
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_DIR: dir,
      FAKE_RS: RS,
      CERT_MANAGER_LEADER_BUDGET_S: '1',
      CERT_MANAGER_LEADER_POLL_S: '0.2',
      ...env,
    },
  });
  const calls = readFileSync(join(dir, 'calls'), 'utf-8').trim().split('\n');
  return { ...res, calls };
}

describe('await-cert-manager-leader.sh', () => {
  it('proceeds when a pod of the current ReplicaSet holds the lease', () => {
    const r = runScript({ FAKE_HOLDER: NEW_HOLDER });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`is held by ${NEW_HOLDER}`);
    expect(r.calls[0]).toMatch(/rollout status deployment\/cert-manager --timeout=1s/);
    expect(r.calls).toContainEqual(
      expect.stringMatching(/-n kube-system get lease cert-manager-controller/),
    );
  });

  it('waits through a handoff from the old ReplicaSet to the current one', () => {
    const r = runScript({
      FAKE_HOLDER: OLD_HOLDER,
      FAKE_HOLDER_AFTER: NEW_HOLDER,
      FAKE_SWITCH_AT: '2',
      CERT_MANAGER_LEADER_BUDGET_S: '10',
    });
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.includes('get lease'))).toHaveLength(2);
  });

  it('refuses at the budget while an old-ReplicaSet pod holds the lease', () => {
    const r = runScript({ FAKE_HOLDER: OLD_HOLDER });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(
      /^::error::The cert-manager controller did not settle as leader within 1s/,
    );
    expect(r.stdout).toContain(
      `held by ${OLD_HOLDER}, not by a pod of the current ReplicaSet cert-manager-5d4b8c7f9`,
    );
  });

  it('refuses at the budget when the lease has no holder', () => {
    const r = runScript({ FAKE_HOLDER: '' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('has no holder yet');
  });

  it('an unreadable lease is bounded, then one clear error with where to look', () => {
    const r = runScript({ FAKE_LEASE_ERR: 'Error from server (Forbidden): leases is forbidden' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('could not read lease kube-system/cert-manager-controller');
    expect(r.stdout).toContain('Forbidden');
    expect(r.stdout).toContain('kubectl -n kube-system get lease cert-manager-controller -o yaml');
  });

  it('refuses when no ReplicaSet carries the Deployment revision', () => {
    const r = runScript({ FAKE_HOLDER: NEW_HOLDER, FAKE_REV: '4' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('carries its revision 4');
  });

  it('a rollout that does not complete fails before the lease is read', () => {
    const r = runScript({ FAKE_HOLDER: NEW_HOLDER, FAKE_ROLLOUT_RC: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('the cert-manager rollout did not complete');
    expect(r.calls.some((c) => c.includes('get lease'))).toBe(false);
  });
});

describe('deploy.yml waits for the leader before the Certificate', () => {
  it('runs the wait after the cert-manager install and before the Certificate apply', () => {
    const install = WF.indexOf('- name: Install cert-manager + Traefik CRDs');
    const wait = WF.indexOf('bash scripts/await-cert-manager-leader.sh');
    const cert = WF.indexOf('- name: Render and apply the TLS Certificate');
    expect(install).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(install);
    expect(cert).toBeGreaterThan(wait);
  });
});
