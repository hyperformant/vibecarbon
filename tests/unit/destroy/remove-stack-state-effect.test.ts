/**
 * `removePulumiStackState` destroy effect — the compose tiers' stack-state
 * reconciliation (plan step `remove-stack-state`).
 *
 * Evidence (e2e run 32309395314, vultr compose restore, 2026-08-19): compose
 * destroy reaps its cloud resources via direct provider APIs and — with the
 * state bucket retained (717d49e7) — left stack `civ1`'s state file
 * describing the deleted server/firewall/rules. The restore re-deploy
 * selected that stale stack; terraform-provider-vultr v2.27.1 cannot prune a
 * deleted firewall rule on refresh (404 surfaces as an ERROR), so `pulumi up`
 * tried to delete the stale rules against the live API and failed. The k8s
 * tiers never hit this because destroyStack runs `pulumi destroy` +
 * `removeStack`; this effect gives the compose tiers the same invariant:
 * the thing that deleted the resources also removes the stack record.
 *
 * The GATES matter as much as the removal:
 *   - a teardown with leak/unverified entries RETAINS the stack — its state
 *     is the only record of what may still be deployed (717d49e7's evidence
 *     principle);
 *   - recorded s3 backend + unresolvable credentials RETAINS the stack —
 *     removing against the file:// fallback would "succeed" against the
 *     wrong backend while the real stale stack lives on;
 *   - foreign/risk-only ledgers still remove — our own teardown is verified
 *     clean (mirrors destroyExitCode's policy).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';

const removeStackStateMock = vi.fn();
vi.mock('../../../src/lib/iac/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    removeStackState: (...args: unknown[]) => removeStackStateMock(...args),
  };
});

const spinnerStub = () => {
  const messages: string[] = [];
  return {
    messages,
    start: (m?: string) => messages.push(`start:${m ?? ''}`),
    stop: (m?: string) => messages.push(`stop:${m ?? ''}`),
    message: (m?: string) => messages.push(`message:${m ?? ''}`),
  };
};

function makeCtx(overrides: Record<string, unknown> = {}) {
  const results = { leaks: createLeakLedger(), servers: [], firewalls: [], sshKeys: [] };
  return {
    plan: { tier: 'compose', stackEnvs: ['civ1'] },
    envConfig: {
      provider: 'hetzner',
      s3: {
        bucket: 'proj-65b772-storage',
        region: 'fsn1',
        endpoint: 'https://fsn1.your-objectstorage.com',
        stateBucket: 'vc-e2e-state-ci-6586f2',
      },
    },
    projectConfig: { projectName: 'proj' },
    environment: 'civ1',
    results,
    spinner: spinnerStub(),
    cwd: '/tmp/nowhere',
    ...overrides,
  };
}

async function runEffect(ctx: ReturnType<typeof makeCtx>) {
  const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');
  await DESTROY_EFFECTS.removePulumiStackState(ctx, {});
}

describe('removePulumiStackState effect', () => {
  beforeEach(() => {
    removeStackStateMock.mockReset();
    removeStackStateMock.mockResolvedValue({ removed: true });
    vi.stubEnv('HETZNER_ACCESS_KEY', 'test-access');
    vi.stubEnv('HETZNER_SECRET_KEY', 'test-secret');
  });

  it('removes the stack record for a clean compose teardown, against the recorded state backend', async () => {
    const ctx = makeCtx();
    await runEffect(ctx);

    expect(removeStackStateMock).toHaveBeenCalledTimes(1);
    const [stackName, options] = removeStackStateMock.mock.calls[0];
    expect(stackName).toBe('civ1');
    expect(options.projectName).toBe('proj');
    expect(options.provider).toBe('hetzner');
    // The recorded backend, not a file:// fallback: stateBucket + endpoint
    // must flow through or the removal silently targets the wrong backend.
    expect(options.s3Config).toMatchObject({
      stateBucket: 'vc-e2e-state-ci-6586f2',
      endpoint: 'https://fsn1.your-objectstorage.com',
    });
    // Clean outcome: nothing lands in the ledger.
    expect(ctx.results.leaks.isClean()).toBe(true);
  });

  it('removes BOTH compose-ha stacks (-primary and -standby)', async () => {
    const ctx = makeCtx({
      plan: { tier: 'compose-ha', stackEnvs: ['civ1-primary', 'civ1-standby'] },
    });
    await runEffect(ctx);

    const names = removeStackStateMock.mock.calls.map((c) => c[0]);
    expect(names).toEqual(['civ1-primary', 'civ1-standby']);
  });

  it('RETAINS the stack when the teardown recorded a leak — state is the evidence', async () => {
    const ctx = makeCtx();
    ctx.results.leaks.leak({
      resourceClass: 'firewall',
      resource: 'proj-civ1-firewall',
      reason: 'delete did not complete',
    });
    await runEffect(ctx);

    expect(removeStackStateMock).not.toHaveBeenCalled();
  });

  it('RETAINS the stack when the teardown recorded an unverified resource', async () => {
    const ctx = makeCtx();
    ctx.results.leaks.unverified({
      resourceClass: 'server',
      resource: 'proj-civ1',
      reason: 'lookup failed',
    });
    await runEffect(ctx);

    expect(removeStackStateMock).not.toHaveBeenCalled();
  });

  it('still removes when the ledger holds only foreign/risk entries (our teardown is clean)', async () => {
    const ctx = makeCtx();
    ctx.results.leaks.foreign({
      resourceClass: 'volume',
      resource: 'pvc-not-ours',
      reason: 'proven foreign',
    });
    ctx.results.leaks.risk({
      resourceClass: 'bucket',
      resource: 'proj-backups',
      reason: 's3 keys mismatch predictor',
    });
    await runEffect(ctx);

    expect(removeStackStateMock).toHaveBeenCalledTimes(1);
  });

  it('RETAINS the stack loudly when the env records an s3 backend but credentials cannot be resolved', async () => {
    vi.stubEnv('HETZNER_ACCESS_KEY', '');
    vi.stubEnv('HETZNER_SECRET_KEY', '');
    const ctx = makeCtx();
    await runEffect(ctx);

    // Removing against the file:// fallback would "succeed" against the
    // wrong backend — the stale stack in the real bucket would live on.
    expect(removeStackStateMock).not.toHaveBeenCalled();
    expect(ctx.spinner.messages.join('\n')).toMatch(/retained|credentials/i);
  });

  it('records an unverified pulumi-stack entry when a removal throws (a retained stale stack fails the next re-deploy)', async () => {
    removeStackStateMock.mockRejectedValue(new Error('SlowDown: backend throttled'));
    const ctx = makeCtx();
    await runEffect(ctx);

    const entries = ctx.results.leaks.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].severity).toBe('unverified');
    expect(entries[0].resourceClass).toBe('pulumi-stack');
    expect(entries[0].resource).toContain('civ1');
  });

  it('keeps going after a first-stack failure so the second stack still gets reconciled', async () => {
    removeStackStateMock
      .mockRejectedValueOnce(new Error('SlowDown'))
      .mockResolvedValueOnce({ removed: true });
    const ctx = makeCtx({
      plan: { tier: 'compose-ha', stackEnvs: ['civ1-primary', 'civ1-standby'] },
    });
    await runEffect(ctx);

    expect(removeStackStateMock).toHaveBeenCalledTimes(2);
    expect(ctx.results.leaks.counts().unverified).toBe(1);
  });
});
