/**
 * A `pulumi destroy` that hits one resource error must still delete
 * everything else it can, and the failure must name what is left.
 *
 * d4-standby, 2026-10-31: the db Droplet's delete failed, and Pulumi stopped
 * scheduling new deletes at the first error ("1 deleted, 2 errored"), so the
 * master Droplet, the reserved IP, the firewall and the VPC were never even
 * attempted. Pulumi's supported answer is `--continue-on-error`
 * (`continueOnError` in the Automation API): keep deleting every resource
 * that does not depend on the failed one. The error that reached the
 * operator then read `error: update failed` and named nothing; it must name
 * the resources still in state and the provider's actual complaint.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PULUMI_FAILURE = [
  'code: -2',
  ' stdout: ',
  ' stderr: Command failed with exit code 1: pulumi destroy --yes --skip-preview --color never --stack d4-standby --non-interactive',
  'Destroying (d4-standby):',
  ' -  digitalocean:index:Droplet db deleting (11s) error:   sdk-v2/provider2.go:574: sdk.helper_schema: Error detaching the volumes from the droplet (614595377): Error detaching volume "4c926666" from droplet (614595377): POST https://api.digitalocean.com/v2/volumes/4c926666/actions: 404 error detaching volume from droplet: not found: provider=digitalocean@4.84.2',
  '    pulumi:pulumi:Stack p-d4-standby  error: update failed',
  'Diagnostics:',
  '  pulumi:pulumi:Stack (p-d4-standby):',
  '    error: update failed',
  '',
  '  digitalocean:index:Droplet (db):',
  '    error:   sdk-v2/provider2.go:574: sdk.helper_schema: Error detaching the volumes from the droplet (614595377): Error detaching volume "4c926666" from droplet (614595377): POST https://api.digitalocean.com/v2/volumes/4c926666/actions: 404 error detaching volume from droplet: not found: provider=digitalocean@4.84.2',
  '    error: deleting urn:pulumi:d4-standby::p::digitalocean:index/droplet:Droplet::db: 1 error occurred:',
].join('\n');

const DB_ERROR =
  'Error detaching the volumes from the droplet (614595377): Error detaching volume "4c926666" from droplet (614595377): POST https://api.digitalocean.com/v2/volumes/4c926666/actions: 404 error detaching volume from droplet: not found: provider=digitalocean@4.84.2';

const LEFT_BEHIND = [
  {
    type: 'pulumi:pulumi:Stack',
    urn: 'urn:pulumi:d4-standby::p::pulumi:pulumi:Stack::p-d4-standby',
  },
  {
    type: 'digitalocean:index/droplet:Droplet',
    urn: 'urn:pulumi:d4-standby::p::digitalocean:index/droplet:Droplet::db',
    id: '614595377',
    outputs: { name: 'p-d4-standby-db' },
  },
  {
    type: 'digitalocean:index/vpc:Vpc',
    urn: 'urn:pulumi:d4-standby::p::digitalocean:index/vpc:Vpc::network',
    id: 'vpc-uuid',
    outputs: { name: 'p-d4-standby-network' },
  },
];

function failingStack() {
  return {
    exportStack: vi.fn(async () => ({ deployment: { resources: structuredClone(LEFT_BEHIND) } })),
    importStack: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    destroy: vi.fn(async () => {
      throw new Error(PULUMI_FAILURE);
    }),
    workspace: { removeStack: vi.fn(async () => undefined) },
  };
}

const selectStackMock = vi.fn();

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: () => {
      throw new Error('createStack must not be called: it would clobber real state');
    },
    create: async () => ({ listStacks: async () => [] }),
  },
}));

describe('destroyStack partial failure', () => {
  beforeEach(() => {
    selectStackMock.mockReset();
  });

  it('asks Pulumi to keep deleting past a failed resource', async () => {
    const stack = failingStack();
    stack.destroy.mockResolvedValue({
      summary: { result: 'succeeded', resourceChanges: { delete: 2 } },
    } as never);
    selectStackMock.mockResolvedValue(stack);

    const { destroyStack } = await import('../../../src/lib/iac/index.js');
    await destroyStack('d4-standby', () => ({}), { projectName: 'p' });

    expect(stack.destroy).toHaveBeenCalledWith(expect.objectContaining({ continueOnError: true }));
  });

  it('names every resource still in state and the provider error, and keeps the stack', async () => {
    const stack = failingStack();
    selectStackMock.mockResolvedValue(stack);

    const { destroyStack } = await import('../../../src/lib/iac/index.js');
    const err = await destroyStack('d4-standby', () => ({}), { projectName: 'p' }).catch(
      (e: unknown) => e as Error & { remainingResources?: unknown[]; cause?: unknown },
    );

    expect(err).toBeInstanceOf(Error);
    expect(err.remainingResources).toEqual([
      {
        type: 'digitalocean:index/droplet:Droplet',
        logicalName: 'db',
        name: 'p-d4-standby-db',
        id: '614595377',
        // Its own diagnostic, from the Diagnostics block for `Droplet (db)`.
        error: DB_ERROR,
      },
      {
        type: 'digitalocean:index/vpc:Vpc',
        logicalName: 'network',
        name: 'p-d4-standby-network',
        id: 'vpc-uuid',
        // No diagnostic of its own: blocked behind the db Droplet.
        error: null,
      },
    ]);
    // The provider's complaint, not the stack-level "update failed".
    expect(err.message).toMatch(/Error detaching the volumes from the droplet \(614595377\)/);
    expect(err.message).not.toMatch(/^error: update failed$/);
    expect(err.message).toMatch(/2 resource\(s\)/);
    // The original stays reachable for the log.
    expect((err.cause as Error).message).toBe(PULUMI_FAILURE);
    expect(stack.workspace.removeStack).not.toHaveBeenCalled();
  });
});

describe('pulumiDiagnosticsByResource', () => {
  it('maps each resource diagnostic to its type and logical name, skipping the stack', async () => {
    const { pulumiDiagnosticsByResource } = await import('../../../src/lib/iac/index.js');
    const twoFailures = `${PULUMI_FAILURE}

  digitalocean:index:Firewall (firewall):
    error: deleting firewall: 409 the firewall is still in use`;
    const map = pulumiDiagnosticsByResource(twoFailures);

    expect(map.get('digitalocean:index:Droplet::db')).toBe(DB_ERROR);
    expect(map.get('digitalocean:index:Firewall::firewall')).toBe(
      'deleting firewall: 409 the firewall is still in use',
    );
    expect([...map.keys()].some((k) => k.startsWith('pulumi:pulumi:Stack'))).toBe(false);
  });

  it('is empty when the output carries no Diagnostics block', async () => {
    const { pulumiDiagnosticsByResource } = await import('../../../src/lib/iac/index.js');
    expect(pulumiDiagnosticsByResource('connect ECONNREFUSED').size).toBe(0);
  });
});

describe('pulumiDestroyFailureCause', () => {
  it('picks the resource diagnostic over the stack-level summary', async () => {
    const { pulumiDestroyFailureCause } = await import('../../../src/lib/iac/index.js');
    expect(pulumiDestroyFailureCause(PULUMI_FAILURE)).toBe(
      'Error detaching the volumes from the droplet (614595377): Error detaching volume "4c926666" from droplet (614595377): POST https://api.digitalocean.com/v2/volumes/4c926666/actions: 404 error detaching volume from droplet: not found: provider=digitalocean@4.84.2',
    );
  });

  it('falls back to the first line when there is no Pulumi diagnostic', async () => {
    const { pulumiDestroyFailureCause } = await import('../../../src/lib/iac/index.js');
    expect(pulumiDestroyFailureCause('connect ECONNREFUSED\nmore')).toBe('connect ECONNREFUSED');
  });
});
