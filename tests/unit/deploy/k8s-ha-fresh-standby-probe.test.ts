/**
 * The k8s-ha streaming probe is skipped for a standby this deploy created.
 *
 * setupReplication asks the primary whether the standby already streams, so a
 * redeploy of a healthy pair keeps its replica instead of reseeding it. The
 * probe reads up to 3 times with 2 s sleeps, so on every cold deploy, where
 * nothing can be streaming yet, it burned 5.2 s on the critical path
 * (5.2/5.2/5.1/5.2 s across runs).
 *
 * The skip is proven safe, not guessed: deployK3s reports `freshCluster` only
 * when this run's provisioning minted the cluster's k3s token. The token is in
 * every node's cloud-init user data, and a user-data change replaces the
 * server, so a minted token means every node is new: a new k3s datastore, so
 * the db PVC and the database on it were created by this deploy. That
 * database ran initdb as a primary; it has no primary_conninfo and is not in
 * recovery, so it cannot be streaming until this reseed seeds it. A run whose
 * provisioning recovered the stack's token, or skipped provisioning (a resumed
 * or warm deploy), never reports it, and the probe runs as before.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ cmd: string; input?: string }> = [];

vi.mock('../../../src/lib/command.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runCommandAsync: vi.fn(async (argv: string[], opts: { input?: string } = {}) => {
    const cmd = argv[argv.length - 1];
    calls.push({ cmd, input: opts.input });
    if (cmd.includes('pg_stat_replication')) return '';
    if (cmd.includes('get pod db-0 -n vibecarbon -o json')) {
      return JSON.stringify({
        status: { phase: 'Running' },
        spec: {
          containers: [
            {
              name: 'db',
              image: 'ghcr.io/hyperformant/postgres:17.11-walg3.0.9-r2',
              volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
            },
          ],
          volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'data-db-0' } }],
        },
        // The reseed matches kubectl's spacing.
      }).replace('"phase":"Running"', '"phase": "Running"');
    }
    // Stop the run right after the basebackup was staged.
    if (cmd.includes('--replicas=0')) throw new Error('stop after stage (test)');
    return '';
  }),
}));
vi.mock('../../../src/lib/ssh.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  scpWithRetry: vi.fn(async () => {}),
}));
vi.mock('../../../src/lib/host-keys.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  seedKnownHosts: vi.fn(async () => {}),
}));
vi.mock('../../../src/lib/deploy/replication.js', async (orig) => {
  const actual = (await orig()) as Record<string, (o: object) => unknown>;
  return {
    ...actual,
    probeStreaming: (o: object) =>
      actual.probeStreaming({ ...o, attempts: 1, sleep: async () => {} }),
  };
});

const { setupReplication } = await import('../../../src/lib/deploy/k8s/ha/index.js');

const base = {
  primaryIp: '10.1.0.1',
  standbyIp: '10.2.0.1',
  sshKeyPath: '/tmp/never-used-key',
  primaryDbPrivateIp: '10.0.1.2',
  standbyDbPrivateIp: '10.0.1.2',
  transportPrepared: true,
  primaryConfigured: true,
};

const probeReads = () => calls.filter((c) => c.cmd.includes('pg_stat_replication')).length;
const staged = () => calls.some((c) => c.input?.includes('pg_basebackup'));

beforeEach(() => {
  process.env.REPL_PASSWORD = 'testreplpass';
  calls.length = 0;
});

describe('setupReplication: the streaming probe and a fresh standby', () => {
  it('a standby this deploy created goes straight to the reseed, without asking the primary', async () => {
    await expect(setupReplication({ ...base, standbyFresh: true })).rejects.toThrow(
      /stop after stage/,
    );
    expect(probeReads()).toBe(0);
    expect(staged()).toBe(true);
  });

  it('any other standby is probed first (a redeploy keeps a streaming replica)', async () => {
    await expect(setupReplication(base)).rejects.toThrow(/stop after stage/);
    expect(probeReads()).toBe(1);
    expect(staged()).toBe(true);
  });

  it('only a literal true skips it', async () => {
    await expect(
      setupReplication({ ...base, standbyFresh: 'yes' as unknown as boolean }),
    ).rejects.toThrow(/stop after stage/);
    expect(probeReads()).toBe(1);
  });
});

describe('the fresh signal comes from minting the k3s token', () => {
  const src = (p: string) => readFileSync(join(__dirname, '../../../src', p), 'utf-8');

  it('deployK3s reports freshCluster only when its own provisioning minted the token', () => {
    const k3s = src('lib/deploy/k8s/k3s.js');
    const body = k3s.slice(k3s.indexOf('async function deployK3sSteps('));
    expect(body).toMatch(/let freshCluster = false;/);
    const infra = body.slice(
      body.indexOf("if (!state.shouldSkip('k3s-infra', infraInputs)) {"),
      body.indexOf("const infraOutputs = state.getStepResult('k3s-infra');"),
    );
    // Set inside the provisioning branch, after the stack is up, from the
    // token probe's answer: never on a skipped (resumed or warm) provision.
    const set = infra.indexOf('freshCluster = !priorK3sToken;');
    expect(set).toBeGreaterThan(infra.indexOf("state.completeStep('k3s-infra', outputs);"));
    expect(body.match(/freshCluster = /g)).toHaveLength(2);
    expect(body).toMatch(/return \{[\s\S]*\bfreshCluster,[\s\S]*\};\n\}/);
  });

  it('the k8s-ha deploy hands the standby cluster’s signal to setupReplication', () => {
    expect(src('lib/deploy/effects/k8s-ha.js')).toMatch(
      /standbyFresh:\s*standbyResult\.freshCluster === true/,
    );
  });
});
