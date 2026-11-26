/**
 * The k8s-ha replication rule's program input: replicationPeerIpFor
 * (src/lib/iac/program-inputs.js).
 *
 * Every up refreshes first, then resets an inline firewall to the rules its
 * program declares. A k8s-ha cluster's firewall carries one rule the deploy
 * writes over REST, UDP 51821 from the peer cluster's database node, so a
 * program that does not declare it drops it on every scale and failover.
 * The programs now declare it from the peer's recorded database address,
 * which this helper reads, keyed by stack (a failover swaps the roles, never
 * the stacks). The census (k8s-firewall-round-trip-census.test.ts) proves the
 * declared rule equals what REST writes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const deployK3s = vi.fn(async (opts: Record<string, unknown>) => ({
  masterIp: '192.0.2.10',
  dbIp: '192.0.2.20',
  dbPrivateIp: '10.0.1.2',
  kubeconfig: `/tmp/kubeconfig-${opts.environment}`,
}));
vi.mock('../../../src/lib/deploy/k8s/k3s.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/deploy/k8s/k3s.js')>()),
  deployK3s,
}));
vi.mock('../../../src/lib/iac/index.js', () => ({
  summarizePulumiError: (err: unknown) => String((err as Error)?.message ?? err),
}));
vi.mock('../../../src/lib/deploy/k8s/ha/index.js', () => ({
  prepareReplicationTransport: vi.fn(async () => {}),
  configurePrimaryForReplication: vi.fn(async () => {}),
  setupReplication: vi.fn(async () => ({ streaming: true, lastState: '' })),
}));
vi.mock('../../../src/lib/deploy/k8s/ha/image-copy.js', () => ({
  copyAppImageToStandby: vi.fn(async () => ({ digest: 'sha256:aa', skipped: true })),
}));

const { replicationPeerIpFor } = await import('../../../src/lib/iac/program-inputs.js');
const { K8S_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/k8s-ha.js');
const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');

const PRIMARY_DB = '198.51.100.1';
const STANDBY_DB = '198.51.100.2';

/** A k8s-ha environment record as the success save writes it (haSidesRecord). */
function haEnv(
  primary: Record<string, unknown>,
  standby: Record<string, unknown>,
): Record<string, unknown> {
  return {
    deployMode: 'kubernetes-ha',
    region: 'nbg1',
    secondaryRegion: 'hel1',
    ha: { enabled: true, failoverRegion: 'hel1', primary, standby },
  };
}

const deployed = () =>
  haEnv(
    { stack: 'prod-primary', region: 'nbg1', masterIp: '192.0.2.1', dbIp: PRIMARY_DB },
    { stack: 'prod-standby', region: 'hel1', masterIp: '192.0.2.2', dbIp: STANDBY_DB },
  );

afterEach(() => {
  vi.restoreAllMocks();
  deployK3s.mockClear();
});

describe('replicationPeerIpFor', () => {
  it("each side gets the other side's recorded database address", () => {
    expect(replicationPeerIpFor(deployed(), 'prod-primary')).toBe(STANDBY_DB);
    expect(replicationPeerIpFor(deployed(), 'prod-standby')).toBe(PRIMARY_DB);
  });

  describe('Review Focus 1: a peer with no recorded address declares no rule', () => {
    it('no record at all (the first deploy)', () => {
      expect(replicationPeerIpFor(undefined, 'prod-primary')).toBeUndefined();
      expect(replicationPeerIpFor({}, 'prod-standby')).toBeUndefined();
    });

    it('the skeleton save of a first deploy that failed: types, no stacks, no addresses', () => {
      const skeleton = haEnv({ masterServerType: 'cx23' }, { masterServerType: 'cx23' });
      expect(replicationPeerIpFor(skeleton, 'prod-primary')).toBeUndefined();
      expect(replicationPeerIpFor(skeleton, 'prod-standby')).toBeUndefined();
    });

    it('the standby has no address on record yet: the primary declares none, the standby its peer', () => {
      const env = haEnv(
        { stack: 'prod-primary', region: 'nbg1', dbIp: PRIMARY_DB },
        { stack: 'prod-standby', region: 'hel1' },
      );
      expect(replicationPeerIpFor(env, 'prod-primary')).toBeUndefined();
      expect(replicationPeerIpFor(env, 'prod-standby')).toBe(PRIMARY_DB);
      const empty = haEnv(
        { stack: 'prod-primary', dbIp: PRIMARY_DB },
        { stack: 'prod-standby', dbIp: '' },
      );
      expect(replicationPeerIpFor(empty, 'prod-primary')).toBeUndefined();
    });

    it('the deploy still opens it by REST, on the firewall the program left without it', async () => {
      const firewalls: Record<string, { id: number; rules: Record<string, unknown>[] }> = {
        'acme-prod-primary-firewall': { id: 1, rules: [] },
        'acme-prod-standby-firewall': { id: 2, rules: [] },
      };
      vi.spyOn(HetznerProvider.prototype, 'findFirewallByName').mockImplementation(
        async (name: string) => firewalls[name] ?? null,
      );
      const set = vi
        .spyOn(HetznerProvider.prototype, 'setFirewallRules')
        .mockResolvedValue(undefined as never);

      await K8S_HA_EFFECTS.haK8sOpenReplicationFirewall({
        options: { provider: 'hetzner', apiToken: 't', projectName: 'acme', environment: 'prod' },
        primaryResult: { stack: 'prod-primary', dbIp: PRIMARY_DB },
        standbyResult: { stack: 'prod-standby', dbIp: STANDBY_DB },
      });

      expect(set.mock.calls.map(([id, rules]) => [id, JSON.stringify(rules)])).toEqual([
        [1, expect.stringContaining(`"${STANDBY_DB}/32"`)],
        [2, expect.stringContaining(`"${PRIMARY_DB}/32"`)],
      ]);
    });
  });

  describe("Review Focus 2: after a failover, each stack takes the OTHER stack's address", () => {
    // swapHaRoles (src/failover.js) swaps ha.primary and ha.standby wholesale.
    const swapped = () =>
      haEnv(
        { stack: 'prod-standby', region: 'hel1', dbIp: STANDBY_DB },
        { stack: 'prod-primary', region: 'nbg1', dbIp: PRIMARY_DB },
      );

    it('keyed by stack, never by the role a stack name was born with', () => {
      // prod-primary is the standby now; its peer is still prod-standby's db.
      expect(replicationPeerIpFor(swapped(), 'prod-primary')).toBe(STANDBY_DB);
      expect(replicationPeerIpFor(swapped(), 'prod-standby')).toBe(PRIMARY_DB);
    });

    it("the deploy's REST opener writes each stack's own firewall the same way", async () => {
      // Role-named before (`<env>-<role>-firewall`): after the swap the
      // primary role's lookup found `acme-prod-primary-firewall`, which is now
      // the standby's, and wrote it the standby role's address: prod-primary's
      // own database address, into its own firewall. Likewise for firewall 2.
      const firewalls: Record<string, { id: number; rules: Record<string, unknown>[] }> = {
        'acme-prod-primary-firewall': { id: 1, rules: [] },
        'acme-prod-standby-firewall': { id: 2, rules: [] },
      };
      vi.spyOn(HetznerProvider.prototype, 'findFirewallByName').mockImplementation(
        async (name: string) => firewalls[name] ?? null,
      );
      const set = vi
        .spyOn(HetznerProvider.prototype, 'setFirewallRules')
        .mockResolvedValue(undefined as never);

      await K8S_HA_EFFECTS.haK8sOpenReplicationFirewall({
        options: { provider: 'hetzner', apiToken: 't', projectName: 'acme', environment: 'prod' },
        // The serving primary is the prod-standby stack.
        primaryResult: { stack: 'prod-standby', dbIp: STANDBY_DB },
        standbyResult: { stack: 'prod-primary', dbIp: PRIMARY_DB },
      });

      const written = Object.fromEntries(
        set.mock.calls.map(([id, rules]) => [id, JSON.stringify(rules)]),
      );
      // Firewall 1 is prod-primary's: its peer is prod-standby's db.
      expect(written[1]).toContain(`"${STANDBY_DB}/32"`);
      expect(written[1]).not.toContain(PRIMARY_DB);
      expect(written[2]).toContain(`"${PRIMARY_DB}/32"`);
      expect(written[2]).not.toContain(STANDBY_DB);
    });
  });

  describe('a record without stacks (written before failover recorded them)', () => {
    // The deploy and scale resolve it as `<env>-primary` primary and
    // `<env>-standby` standby; the helper maps it the same way.
    const unstacked = () =>
      haEnv(
        { region: 'nbg1', masterIp: '192.0.2.1', dbIp: PRIMARY_DB },
        { region: 'hel1', masterIp: '192.0.2.2', dbIp: STANDBY_DB },
      );

    it("each default stack gets the other side's recorded address", () => {
      expect(replicationPeerIpFor(unstacked(), 'prod-primary')).toBe(STANDBY_DB);
      expect(replicationPeerIpFor(unstacked(), 'prod-standby')).toBe(PRIMARY_DB);
    });

    it('a stack of another name is neither side', () => {
      expect(replicationPeerIpFor(unstacked(), 'prod')).toBeUndefined();
      expect(replicationPeerIpFor(unstacked(), 'prod-blue')).toBeUndefined();
    });

    it('a hand-edited address is still refused', () => {
      const env = haEnv({ dbIp: PRIMARY_DB }, { dbIp: '10.0.0.300' });
      expect(() => replicationPeerIpFor(env, 'prod-primary')).toThrow(
        /^ha\.standby\.dbIp "10\.0\.0\.300" in environment prod is not an IPv4 address \(the replication peer of stack prod-primary;/,
      );
    });
  });

  describe('Review Focus 3: a non-HA environment never gets a rule', () => {
    it('no ha record', () => {
      const k8s = { deployMode: 'kubernetes', servers: [{ name: 'prod', ip: '192.0.2.1' }] };
      expect(replicationPeerIpFor(k8s, 'prod')).toBeUndefined();
    });

    it('a stack that is neither recorded side', () => {
      expect(replicationPeerIpFor(deployed(), 'prod')).toBeUndefined();
      expect(replicationPeerIpFor(deployed(), 'staging-primary')).toBeUndefined();
    });
  });

  describe('Review Focus 5: a recorded address that is not IPv4 is refused', () => {
    it.each([['10.0.0.300'], ['not-an-ip'], ['198.51.100.2/32'], ['2001:db8::1']])(
      '%s: names the environment, the stack and the value',
      (bad) => {
        const env = haEnv(
          { stack: 'prod-primary', dbIp: PRIMARY_DB },
          { stack: 'prod-standby', dbIp: bad },
        );
        expect(() => replicationPeerIpFor(env, 'prod-primary')).toThrow(
          new Error(
            `ha.standby.dbIp ${JSON.stringify(bad)} in environment prod is not an IPv4 address ` +
              "(the replication peer of stack prod-primary; set it to that database node's public " +
              'IPv4 in .vibecarbon.json, or delete it and vibecarbon deploy records it again)',
          ),
        );
        // The other side reads the good record.
        expect(replicationPeerIpFor(env, 'prod-standby')).toBe(PRIMARY_DB);
      },
    );

    it('a value that is not a string at all', () => {
      const env = haEnv({ stack: 'prod-primary', dbIp: 42 }, { stack: 'prod-standby' });
      expect(() => replicationPeerIpFor(env, 'prod-standby')).toThrow(
        /^ha\.primary\.dbIp 42 in environment prod is not an IPv4 address/,
      );
    });

    it("the k8s-ha deploy refuses before either cluster's deploy starts", async () => {
      const envConfig = haEnv(
        { stack: 'prod-primary', region: 'nbg1', dbIp: PRIMARY_DB },
        { stack: 'prod-standby', region: 'hel1', dbIp: 'not-an-ip' },
      );
      await expect(
        K8S_HA_EFFECTS.haK8sProvisionClusters({
          options: {
            environment: 'prod',
            region: 'nbg1',
            secondaryRegion: 'hel1',
            envConfig,
            haStacks: {
              primary: { stack: 'prod-primary', region: 'nbg1' },
              standby: { stack: 'prod-standby', region: 'hel1' },
            },
          },
        }),
      ).rejects.toThrow(/^ha\.standby\.dbIp "not-an-ip" in environment prod/);
      expect(deployK3s).not.toHaveBeenCalled();
    });
  });
});
