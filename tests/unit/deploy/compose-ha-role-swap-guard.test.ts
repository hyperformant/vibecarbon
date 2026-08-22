import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A compose-HA failover persists the swap by flipping the `role` FIELD on
// servers[]: array order, entry names, and the Pulumi stack names are all
// untouched. `vibecarbon deploy` resolves the pair from the STACK names
// (`${env}-primary` / `${env}-standby`) and never reads the role field, so a
// redeploy of a swapped environment re-points DNS at the retired node and runs
// configureStandbyReplication — destructive by design (wipes PGDATA and
// re-basebackups) — against the PROMOTED primary holding every post-failover
// write. Until role-aware compose-HA redeploy exists, deploy must REFUSE.
//
// These tests pin the detector's semantics, its wiring position (ahead of every
// infra mutation), and the failover recovery text that used to send operators
// straight into this path.

// Stop executeDeployment at the statement that follows the guard. The no-fire
// cases then prove two things at once: the guard let the deploy through, and it
// sits ahead of even the host-tooling preflight — hence ahead of the operator
// firewall patch, the S3 bucket creation, the image push and the DNS warm-up.
vi.mock('../../../src/lib/deploy/preflight.js', () => ({
  checkDeployPrerequisites: () => {
    throw new Error('STOP_AFTER_ROLE_SWAP_GUARD');
  },
}));

// The first two mutations executeDeployment would perform on an already-deployed
// environment: ensureOperatorIpAccess PATCHES the live cloud firewall, and the
// StateTracker constructor writes deploy state to disk. Mocked so the refusal
// case can assert neither was reached — the guard must be ahead of mutations,
// not merely ahead of the tooling preflight.
const ensureOperatorIpAccess = vi.fn(async () => ({ added: false }));
const StateTracker = vi.fn();
vi.mock('../../../src/lib/operator-ip.js', () => ({
  ensureOperatorIpAccess: (...args: unknown[]) => ensureOperatorIpAccess(...args),
}));
vi.mock('../../../src/lib/deploy/state.js', () => ({
  StateTracker: class {
    constructor(...args: unknown[]) {
      StateTracker(...args);
    }
  },
}));

const {
  assertNoComposeHaRoleSwap,
  composeHaFailoverRecoveryInstructions,
  composeHaStandbyResyncHint,
  detectComposeHaRoleSwap,
} = await import('../../../src/lib/deploy/compose/ha-role-swap.js');
const { executeDeployment } = await import('../../../src/lib/deploy/orchestrator.js');
const { TIERS } = await import('../../../src/lib/deploy/tier-registry.js');

const PROJECT = 'testapp';
const ENV = 'prod';

/** The exact servers[] shape haPersistPendingConfig writes, with the two roles
 *  parameterized so a post-failover swap is one argument away. */
const composeHaServers = (primaryStackRole: string, standbyStackRole: string) => [
  {
    name: `${PROJECT}-${ENV}-primary`,
    id: 101,
    ip: '10.0.0.1',
    region: 'nbg1',
    serverType: 'cx23',
    role: primaryStackRole,
  },
  {
    name: `${PROJECT}-${ENV}-standby`,
    id: 102,
    ip: '10.0.0.2',
    region: 'fsn1',
    serverType: 'cx23',
    role: standbyStackRole,
  },
];

const healthyComposeHa = () => ({
  deployMode: 'compose-ha',
  ha: { enabled: true, failoverRegion: 'fsn1' },
  region: 'nbg1',
  secondaryRegion: 'fsn1',
  servers: composeHaServers('primary', 'standby'),
});

/** Exactly what failoverComposeHA persists: roles flipped in place. */
const swappedComposeHa = () => ({
  ...healthyComposeHa(),
  region: 'fsn1',
  secondaryRegion: 'nbg1',
  ha: { enabled: true, failoverRegion: 'nbg1' },
  servers: composeHaServers('standby', 'primary'),
  lastFailover: '2026-08-10T22:15:00.000Z',
});

/** One healthy config per tier — the census below asserts this map stays in
 *  step with TIERS, so a fifth tier can't be added without deciding whether the
 *  guard applies to it. */
const HEALTHY_BY_TIER: Record<string, Record<string, unknown>> = {
  compose: {
    deployMode: 'compose',
    servers: [{ name: `${PROJECT}-${ENV}`, id: 1, ip: '10.0.0.9', region: 'nbg1' }],
  },
  'compose-ha': healthyComposeHa(),
  k8s: {
    deployMode: 'kubernetes',
    servers: [
      { name: 'master', ip: '10.0.1.1', region: 'nbg1', role: 'master' },
      { name: 'supabase', ip: '10.0.1.2', region: 'nbg1', role: 'supabase' },
      { name: 'worker-1', ip: '10.0.1.3', region: 'nbg1', role: 'worker' },
    ],
  },
  'k8s-ha': {
    deployMode: 'kubernetes',
    ha: {
      enabled: true,
      primary: { stack: `${ENV}-primary`, region: 'nbg1' },
      standby: { stack: `${ENV}-standby`, region: 'fsn1' },
    },
    servers: [
      { name: 'primary', ip: '10.0.2.1', supabaseIp: '10.0.2.2', region: 'nbg1' },
      { name: 'standby', ip: '10.0.2.3', supabaseIp: '10.0.2.4', region: 'fsn1' },
    ],
  },
};

const detect = (envConfig: unknown) =>
  detectComposeHaRoleSwap({ projectName: PROJECT, environment: ENV, envConfig });

describe('compose-HA role-swap detector', () => {
  it('fires on the post-failover shape: the -primary stack entry carries role standby', () => {
    const detail = detect(swappedComposeHa());
    expect(detail).not.toBeNull();
    expect(detail.byStack.primary.ip).toBe('10.0.0.1');
    expect(detail.byStack.primary.role).toBe('standby');
    expect(detail.byStack.standby.ip).toBe('10.0.0.2');
    expect(detail.byStack.standby.role).toBe('primary');
    expect(detail.lastFailover).toBe('2026-08-10T22:15:00.000Z');
  });

  it('does not fire on a symmetric compose-HA config', () => {
    expect(detect(healthyComposeHa())).toBeNull();
  });

  it('resolves stack identity from the name suffix when the project was renamed', () => {
    const renamed = swappedComposeHa();
    renamed.servers = renamed.servers.map((s) => ({
      ...s,
      name: s.name.replace(`${PROJECT}-${ENV}-`, 'oldname-oldenv-'),
    }));
    expect(detect(renamed)).not.toBeNull();
  });

  it('falls back to providerServerName only when `name` yields no identity', () => {
    const swapped = swappedComposeHa();
    swapped.servers = swapped.servers.map((s) => ({
      ...s,
      providerServerName: s.name,
      // Bare 'primary'/'standby' matches neither expected stack name nor the
      // `-primary`/`-standby` suffix, so identity has to come from the fallback.
      name: s.role === 'primary' ? 'standby' : 'primary',
    }));
    expect(detect(swapped)).not.toBeNull();
  });

  // `scale`'s blue-green replacement spreads the original entry (keeping `name`)
  // and stamps `providerServerName` with the permanent provider name. Scaling a
  // FAILED-OVER environment can therefore leave the two fields pointing at
  // different stacks. `name` is the provisioning-time signal and must win:
  // reading both as one pool let whichever stack was tested first decide, which
  // resolved this shape backwards and silenced the guard.
  it('fires on the crosswise scale-after-failover shape (name wins over providerServerName)', () => {
    const crosswise = {
      ...swappedComposeHa(),
      servers: [
        {
          name: `${PROJECT}-${ENV}-primary`,
          providerServerName: `${PROJECT}-${ENV}-standby`,
          ip: '10.0.0.1',
          role: 'standby',
        },
        {
          name: `${PROJECT}-${ENV}-standby`,
          providerServerName: `${PROJECT}-${ENV}-primary`,
          ip: '10.0.0.2',
          role: 'primary',
        },
      ],
    };
    const detail = detect(crosswise);
    expect(detail).not.toBeNull();
    expect(detail.byStack.primary.ip).toBe('10.0.0.1');
    expect(detail.byStack.standby.ip).toBe('10.0.0.2');
  });

  it('fires on the mirror of the crosswise shape', () => {
    const mirrored = {
      ...swappedComposeHa(),
      servers: [
        {
          name: `${PROJECT}-${ENV}-standby`,
          providerServerName: `${PROJECT}-${ENV}-primary`,
          ip: '10.0.0.2',
          role: 'primary',
        },
        {
          name: `${PROJECT}-${ENV}-primary`,
          providerServerName: `${PROJECT}-${ENV}-standby`,
          ip: '10.0.0.1',
          role: 'standby',
        },
      ],
    };
    const detail = detect(mirrored);
    expect(detail).not.toBeNull();
    expect(detail.byStack.primary.ip).toBe('10.0.0.1');
    expect(detail.byStack.standby.ip).toBe('10.0.0.2');
  });

  it('stays silent when a scaled env was never failed over (roles still match `name`)', () => {
    const scaledOnly = {
      ...healthyComposeHa(),
      servers: [
        {
          name: `${PROJECT}-${ENV}-primary`,
          providerServerName: `${PROJECT}-${ENV}-standby`,
          ip: '10.0.0.1',
          role: 'primary',
        },
        {
          name: `${PROJECT}-${ENV}-standby`,
          providerServerName: `${PROJECT}-${ENV}-primary`,
          ip: '10.0.0.2',
          role: 'standby',
        },
      ],
    };
    expect(detect(scaledOnly)).toBeNull();
  });

  it('does not fire on a legacy compose-HA config with no role fields', () => {
    const legacy = healthyComposeHa();
    legacy.servers = legacy.servers.map(({ role: _role, ...rest }) => rest);
    expect(detect(legacy)).toBeNull();
  });

  it('does not fire when stack identity cannot be resolved from any entry', () => {
    const nameless = swappedComposeHa();
    nameless.servers = nameless.servers.map(({ name: _name, ...rest }) => rest);
    expect(detect(nameless)).toBeNull();
  });

  it('does not fire when both entries resolve to the SAME stack', () => {
    const ambiguous = swappedComposeHa();
    ambiguous.servers = ambiguous.servers.map((s) => ({
      ...s,
      name: `${PROJECT}-${ENV}-primary`,
    }));
    expect(detect(ambiguous)).toBeNull();
  });

  it('does not fire on roles outside the primary/standby pair', () => {
    const odd = healthyComposeHa();
    odd.servers = composeHaServers('master', 'worker');
    expect(detect(odd)).toBeNull();
  });

  it('does not fire on a partially-provisioned env (servers still empty)', () => {
    expect(detect({ deployMode: 'compose-ha', status: 'deploying', servers: [] })).toBeNull();
    expect(detect({ deployMode: 'compose-ha' })).toBeNull();
    expect(detect(undefined)).toBeNull();
  });
});

describe('compose-HA role-swap detector — tier census', () => {
  it('covers every tier in the registry', () => {
    expect(Object.keys(HEALTHY_BY_TIER).sort()).toEqual([...TIERS].sort());
  });

  for (const tier of TIERS) {
    it(`does not fire on a healthy ${tier} config`, () => {
      expect(detect(HEALTHY_BY_TIER[tier])).toBeNull();
    });
  }

  // k8s-HA has its own role reconciler (swapHaRoles writes ha.primary/ha.standby
  // wholesale and orchestrator.js derives haStacks from them), so its
  // post-failover config MUST stay deployable — that reconverge deploy is a
  // green e2e step.
  it('does not fire on a post-failover k8s-HA config (it has its own reconverge path)', () => {
    const k8sHa = structuredClone(HEALTHY_BY_TIER['k8s-ha']) as Record<string, any>;
    [k8sHa.ha.primary, k8sHa.ha.standby] = [k8sHa.ha.standby, k8sHa.ha.primary];
    expect(detect(k8sHa)).toBeNull();
  });
});

describe('compose-HA role-swap refusal message', () => {
  const message = (() => {
    try {
      assertNoComposeHaRoleSwap({
        projectName: PROJECT,
        environment: ENV,
        envConfig: swappedComposeHa(),
      });
      return '';
    } catch (err) {
      return (err as Error).message;
    }
  })();

  it('names the failover swap and the environment', () => {
    expect(message).toMatch(/failover has swapped/i);
    expect(message).toContain(`"${ENV}"`);
  });

  it('names both nodes with the stack each was provisioned as', () => {
    expect(message).toContain('10.0.0.2');
    expect(message).toContain('10.0.0.1');
    expect(message).toContain(`${ENV}-standby`);
    expect(message).toContain(`${ENV}-primary`);
  });

  it('states the two destructive consequences: DNS re-point and the wiping re-seed', () => {
    expect(message).toMatch(/DNS/);
    expect(message).toMatch(/WIPE/);
    expect(message).toMatch(/re-seed/i);
  });

  it('says the path is blocked pending role-aware redeploy and points at the runbook', () => {
    expect(message).toMatch(/role-aware/i);
    expect(message).toContain('docs/rto-rpo.md');
  });

  it('offers no bypass flag', () => {
    expect(message).not.toMatch(/-force|--force|-allow|bypass|override/i);
  });

  it('stays silent on a symmetric config', () => {
    expect(() =>
      assertNoComposeHaRoleSwap({
        projectName: PROJECT,
        environment: ENV,
        envConfig: healthyComposeHa(),
      }),
    ).not.toThrow();
  });
});

describe('deploy path wiring', () => {
  const gathered = (envConfig: Record<string, unknown>) => ({
    projectConfig: { projectName: PROJECT, environments: { [ENV]: envConfig } },
    envConfig,
    environment: ENV,
    config: { environment: ENV, deployMode: envConfig.deployMode, ha: envConfig.ha },
  });

  beforeEach(() => {
    ensureOperatorIpAccess.mockClear();
    StateTracker.mockClear();
  });

  it('refuses a swapped compose-HA environment before any infra mutation', async () => {
    await expect(executeDeployment({}, gathered(swappedComposeHa()))).rejects.toThrow(
      /failover has swapped/i,
    );
    // Nothing touched: the live-firewall patch and the deploy-state write are
    // the first two mutations past this point, and both are still untouched.
    expect(ensureOperatorIpAccess).not.toHaveBeenCalled();
    expect(StateTracker).not.toHaveBeenCalled();
  });

  it('lets a symmetric compose-HA environment through to the rest of the deploy', async () => {
    await expect(executeDeployment({}, gathered(healthyComposeHa()))).rejects.toThrow(
      'STOP_AFTER_ROLE_SWAP_GUARD',
    );
  });

  it('lets every other tier through', async () => {
    for (const tier of TIERS.filter((t: string) => t !== 'compose-ha')) {
      await expect(executeDeployment({}, gathered(HEALTHY_BY_TIER[tier]))).rejects.toThrow(
        'STOP_AFTER_ROLE_SWAP_GUARD',
      );
    }
  });
});

describe('failover recovery instructions', () => {
  const lines = composeHaFailoverRecoveryInstructions({
    envName: ENV,
    promotedIp: '10.0.0.2',
    retiredIp: '10.0.0.1',
  });

  it('names the promoted node as the one holding the writes', () => {
    expect(lines.join('\n')).toContain('10.0.0.2');
  });

  it('tells the operator NOT to redeploy, and why', () => {
    const text = lines.join('\n');
    expect(text).toMatch(/do not run .*vibecarbon deploy/i);
    expect(text).toMatch(/WIPE/);
  });

  it('points at the same runbook the refusal does', () => {
    expect(lines.join('\n')).toContain('docs/rto-rpo.md');
  });

  it('is what failoverComposeHA prints — the old "Redeploy to update configuration" is gone', () => {
    const haSource = readFileSync(join(process.cwd(), 'src/lib/deploy/compose/ha.js'), 'utf-8');
    // Scope to the render region (everything failoverComposeHA emits after the
    // success line) so an import alone can't satisfy the pin — the CALL has to
    // be where the instructions are actually printed.
    const renderRegion = haSource.slice(haSource.indexOf("p.log.success('Failover complete')"));
    expect(renderRegion).not.toBe('');
    expect(renderRegion).toContain('composeHaFailoverRecoveryInstructions({');
    expect(renderRegion).toContain('Recovery instructions:');
    expect(haSource).not.toContain('Redeploy to update configuration');
  });
});

describe('standby resync hint (restore.js post-restore re-seed failure)', () => {
  const hint = (envConfig: Record<string, unknown>) =>
    composeHaStandbyResyncHint({ projectName: PROJECT, environment: ENV, envConfig });

  it('still names deploy as the resync for a symmetric environment', () => {
    expect(hint(healthyComposeHa())).toBe(
      `Run \`vibecarbon deploy ${ENV}\` to resync the standby.`,
    );
  });

  it('says deploy cannot resync a swapped environment, and why', () => {
    const text = hint(swappedComposeHa());
    expect(text).toMatch(/cannot resync/i);
    expect(text).toMatch(/failover has swapped/i);
    expect(text).toContain('docs/rto-rpo.md');
  });

  it('is the hint restore.js actually renders', () => {
    const restoreSource = readFileSync(join(process.cwd(), 'src/restore.js'), 'utf-8');
    expect(restoreSource).toContain('composeHaStandbyResyncHint({');
    expect(restoreSource).not.toContain('to resync the standby.`');
  });
});
