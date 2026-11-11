/**
 * Where the deploy releases a DigitalOcean cluster's retired reserved IP
 * (k8s/retired-reserved-ip.js), and what the k8s-ha success save keeps of it.
 *
 * Review focus: the release runs after the public probe (the cluster serves
 * at its new address) and before the success save (which reads the on-disk
 * record fresh, so it keeps only a reserved IP that stayed). It is handed
 * what it needs to decide whether DNS has left the address: the domain, the
 * new address, and where this run's DNS writer put the records and when
 * (dnsWrite, from the single-k8s writer's finish or the k8s-ha plan's
 * update-dns step). The save must not drop a reserved IP that stayed, or no
 * later deploy or destroy would find it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const { haSidesRecord } = await import('../../../src/lib/deploy/orchestrator.js');

const src = readFileSync(
  fileURLToPath(new URL('../../../src/lib/deploy/orchestrator.js', import.meta.url)),
  'utf8',
);

describe('the deploy releases a retired reserved IP between the probe and the save', () => {
  const release = src.indexOf('await releaseRetiredReservedIps({');

  it('is called exactly once, on the k8s tiers only', () => {
    expect(release).toBeGreaterThan(0);
    expect(src.indexOf('await releaseRetiredReservedIps(', release + 1)).toBe(-1);
    const gate = src.lastIndexOf('if (', release);
    expect(src.slice(gate, release)).toMatch(/^if \(isK8sTier\(tier\)\) \{/);
  });

  it('after the public probe, which throws on failure', () => {
    const probeThrow = src.lastIndexOf('throw new Error(`Public health probe failed: ');
    expect(probeThrow).toBeGreaterThan(0);
    expect(release).toBeGreaterThan(probeThrow);
  });

  it('before the success save, which reads the record fresh', () => {
    const save = src.indexOf('updateProjectConfig((persistedConfig) => {', release);
    expect(save).toBeGreaterThan(release);
    expect(src.slice(release, save)).toContain('// --- STEP 6: Finalize Config');
    // The save rebuilds from what is on disk now, not the env read at start.
    expect(src.slice(save, save + 200)).toMatch(
      /const persistedEnvConfig = persistedConfig\.environments\?\.\[environment\]/,
    );
  });
});

describe('the release is told where DNS points', () => {
  const release = src.indexOf('await releaseRetiredReservedIps({');
  const args = src.slice(release, src.indexOf('});', release));

  it("gets the domain, the new address and this run's DNS write", () => {
    expect(args).toMatch(/\bdomain,/);
    expect(args).toMatch(/\bdnsWrite,/);
    // k8s-ha: the role primary's address, where its records point.
    expect(args).toContain('newAddress: clusterIngressIp(deployResult.primary ?? deployResult),');
  });

  it("gets a way to take the address out of the stack, and to list the zone's records", () => {
    expect(args).toMatch(/\bdropRetired,/);
    expect(args).toMatch(/\bzoneRecordsAt,/);
    const gate = src.lastIndexOf('if (isK8sTier(tier)) {', release);
    const setup = src.slice(gate, release);
    // An existing stack only (never an empty one made in its place), and the
    // same surgery every up runs.
    const drop = setup.slice(setup.indexOf('const dropRetired = createDropRetired({'));
    expect(drop).toMatch(/getOrCreateStack\(stackName, async \(\) => \(\{\}\), \{/);
    expect(drop).toContain('requireExisting: true,');
    // The options createDropRetired hands the surgery carry its recorder, so
    // an address the surgery takes out that no record names is recorded
    // (createDropRetired's own test), never left with no record.
    expect(drop).toContain('dropRetiredStackResources(stack, ingressProviderId, options)');
    expect(drop.slice(0, drop.indexOf('openStack'))).toMatch(/\benvironment,/);
    // Managed DNS only, through the backend that wrote the records.
    expect(setup).toMatch(
      /const zoneRecordsAt =\s+hasAutomatedDns\(dnsProvider\) && dnsToken && dnsZoneId\s+\? async \(address\) =>\s+\(await getDnsProvider\(dnsProvider\)\)\.findARecordsAt\(dnsToken, dnsZoneId, address\)\s+: null;/,
    );
  });

  it('dnsWrite is declared once, before the tiers, and set only by the two DNS writers', () => {
    const decl = src.indexOf('let dnsWrite = null;');
    expect(decl).toBeGreaterThan(0);
    expect(src.indexOf('let dnsWrite', decl + 1)).toBe(-1);
    const start = src.indexOf('let deployResult;');
    expect(decl).toBeGreaterThan(start);
    expect(decl).toBeLessThan(src.indexOf("if (tier === 'compose') {", start));
    const sets = [...src.matchAll(/\bdnsWrite = (.+);/g)].map((m) => m[1]);
    expect(sets.sort()).toEqual(
      ['await k8sDns.finish(deployResult)', 'k8sHaCtx.dnsWrite ?? null', 'null'].sort(),
    );
  });

  it("single k8s: the writer's finish, only when the records are managed", () => {
    const at = src.indexOf('dnsWrite = await k8sDns.finish(deployResult);');
    const gate = src.lastIndexOf('if (', at);
    expect(src.slice(gate, at)).toMatch(
      /^if \(k8sDns && domain && hasAutomatedDns\(dnsProvider\)\) \{/,
    );
  });

  it("k8s-ha: the plan's update-dns step, read after the plan ran", () => {
    const plan = src.indexOf("runPlan(planDeploy('k8s-ha', config), k8sHaCtx, EFFECTS)");
    const at = src.indexOf('dnsWrite = k8sHaCtx.dnsWrite ?? null;');
    expect(plan).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(plan);
  });
});

describe('haSidesRecord: each side records its ingress address', () => {
  const fallback = { region: 'nyc3', secondaryRegion: 'sfo3', minWorkers: 1 };
  const side = (stack: string, masterIp: string, extra: Record<string, unknown> = {}) => ({
    stack,
    masterIp,
    dbIp: '192.0.2.10',
    dbPrivateIp: '10.0.1.2',
    ...extra,
  });

  it('DigitalOcean: ingressIp is the master, and no floatingIp', () => {
    const record = haSidesRecord(
      { primary: side('prod', '198.51.100.7'), standby: side('prod-standby', '198.51.100.8') },
      fallback,
      undefined,
    );
    expect(record.primary.ingressIp).toBe('198.51.100.7');
    expect(record.standby.ingressIp).toBe('198.51.100.8');
    expect(record.primary.floatingIp).toBeUndefined();
    expect(record.standby.floatingIp).toBeUndefined();
  });

  it('Hetzner and Linode: ingressIp and floatingIp are the floating IP', () => {
    const record = haSidesRecord(
      {
        primary: side('prod', '198.51.100.7', { floatingIp: '203.0.113.9' }),
        standby: side('prod-standby', '198.51.100.8', { floatingIp: '203.0.113.10' }),
      },
      fallback,
      undefined,
    );
    expect(record.primary).toMatchObject({ ingressIp: '203.0.113.9', floatingIp: '203.0.113.9' });
    expect(record.standby).toMatchObject({
      ingressIp: '203.0.113.10',
      floatingIp: '203.0.113.10',
    });
  });

  it('a reserved IP the release kept stays on record, with its own stack', () => {
    // After a failover the roles are swapped: the `prod-standby` stack is the
    // role primary now. The kept address follows its stack, not its role.
    const prior = {
      primary: { stack: 'prod-standby', floatingIp: '203.0.113.10' },
      standby: { stack: 'prod' },
    };
    const record = haSidesRecord(
      { primary: side('prod-standby', '198.51.100.8'), standby: side('prod', '198.51.100.7') },
      fallback,
      prior,
    );
    expect(record.primary).toMatchObject({ ingressIp: '198.51.100.8', floatingIp: '203.0.113.10' });
    expect(record.standby.floatingIp).toBeUndefined();
  });

  it('a side recorded without its stack keeps its reserved IP by role', () => {
    // The surgery records a retired address onto a side saved before sides
    // carried `.stack`; the save must not drop it.
    const prior = { primary: { floatingIp: '203.0.113.9' }, standby: { stack: 'prod-standby' } };
    const record = haSidesRecord(
      {
        primary: side('prod-primary', '198.51.100.7'),
        standby: side('prod-standby', '198.51.100.8'),
      },
      fallback,
      prior,
    );
    expect(record.primary.floatingIp).toBe('203.0.113.9');
    expect(record.standby.floatingIp).toBeUndefined();
    // A side that records another stack is not matched by role.
    const swapped = haSidesRecord(
      {
        primary: side('prod-primary', '198.51.100.7'),
        standby: side('prod-standby', '198.51.100.8'),
      },
      fallback,
      { primary: { stack: 'prod-other', floatingIp: '203.0.113.9' } },
    );
    expect(swapped.primary.floatingIp).toBeUndefined();
  });
});

describe('the up records what the surgery takes out', () => {
  const k3s = readFileSync(
    fileURLToPath(new URL('../../../src/lib/deploy/k8s/k3s.js', import.meta.url)),
    'utf8',
  );
  it("deployK3s's up hands the addresses to the environment's record, under the operator's name", () => {
    const up = k3s.indexOf('upStack(options.environment, program, {');
    const call = k3s.slice(up, k3s.indexOf('requiredOutputs,', up));
    expect(call).toMatch(
      /recordRetiredAddresses: \(addresses\) =>\s+recordRetiredReservedIps\(\{\s+environment: options\.operatorEnv \?\? options\.environment,\s+stackName: options\.environment,\s+addresses,/,
    );
  });
});
