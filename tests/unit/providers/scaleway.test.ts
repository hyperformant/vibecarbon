import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ScalewayProvider unit suite (2026-08 expansion PR 3). Provider-specific
 * behavior only — the generic contract (statics shapes, EXPECTED values,
 * abstract-surface completeness, buildIacEnv generic assertions) lives in
 * provider-contract.test.ts. This file pins:
 *   - the operator-facing (SCALEWAY_*) vs plugin-native (SCW_*) name split
 *     and the buildIacEnv triple/throw + SCW_* EMIT (the multi-cred seam);
 *   - the plain-text-wire ASCII guard (no base64 leg exists on Scaleway);
 *   - label round-trips;
 *   - routed-IP extraction (public_ips[] family axis + legacy fallback);
 *   - the ATOMIC whole-ruleset replace (one PUT — never Vultr's
 *     delete-then-recreate) and applyOperatorCidrs' per-CIDR expansion;
 *   - the billing-leak census: deleteServer's terminate → wait-gone →
 *     delete-detached-SBS → release-flexible-IP chain, in BOTH modes
 *     (terminate only DETACHES sbs_volume — SDK verbatim, audit).
 */

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import {
  assertAsciiCloudInit,
  decodeLabels,
  encodeLabel,
  encodeLabels,
  ScalewayProvider,
} from '../../../src/lib/providers/scaleway.js';

const jsonResp = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

beforeEach(() => {
  fetchWithRetryMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('ScalewayProvider statics', () => {
  it('splits operator-facing SCALEWAY_SECRET_KEY from the plugin-native SCW_SECRET_KEY', () => {
    // Same operator-vs-plugin convention as every sibling
    // (HETZNER_API_TOKEN→HCLOUD_TOKEN, VULTR_API_TOKEN→VULTR_API_KEY): the
    // operator sets the spelled-out name; the Pulumi plugin reads SCW_*.
    // buildIacEnv is the only place the SCW_* names appear (asserted below).
    expect(ScalewayProvider.TOKEN_ENV).toBe('SCALEWAY_SECRET_KEY');
    expect(ScalewayProvider.CLI_TOKEN_ENV).toBe('SCW_SECRET_KEY');
    expect(ScalewayProvider.TOKEN_ENV).not.toBe(ScalewayProvider.CLI_TOKEN_ENV);
  });

  it('OBJECT_STORAGE_ENV is the SAME IAM pair as compute — no separate storage keys exist', () => {
    expect(ScalewayProvider.OBJECT_STORAGE_ENV).toEqual([
      'SCALEWAY_ACCESS_KEY',
      'SCALEWAY_SECRET_KEY',
    ]);
  });

  it('REGIONS are keyed on ZONES (3-part) — the audited BASIC3+DEV1-M set', () => {
    expect(Object.keys(ScalewayProvider.REGIONS)).toEqual([
      'fr-par-1',
      'fr-par-2',
      'nl-ams-1',
      'nl-ams-2',
    ]);
    for (const zone of Object.keys(ScalewayProvider.REGIONS)) {
      expect(zone).toMatch(/^[a-z]{2}-[a-z]{3,7}-[0-9]{1,2}$/); // SDK zone regex
    }
  });

  it('pins the compose image as the marketplace LABEL, never a UUID (per-zone/per-volume-type UUIDs)', () => {
    expect(ScalewayProvider.COMPOSE_IMAGE).toBe('ubuntu_noble');
    expect(ScalewayProvider.COMPOSE_IMAGE).not.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('pins the 10-minute cloud-init budget (Docker is NOT preinstalled on ubuntu_noble)', () => {
    expect(ScalewayProvider.CLOUD_INIT_READY_TIMEOUT_MS).toBe(600_000);
  });

  it('COMPOSE_ROOT_VOLUME_GB stays in lockstep with the Pulumi program', async () => {
    const { readFileSync } = await import('node:fs');
    const program = readFileSync('src/lib/iac/programs/scaleway-compose.js', 'utf-8');
    expect(program).toContain(`const ROOT_VOLUME_GB = ${ScalewayProvider.COMPOSE_ROOT_VOLUME_GB};`);
  });

  it('getDefaultStandbyRegion pairs cross-country with matching AZ ordinals', () => {
    expect(ScalewayProvider.getDefaultStandbyRegion('fr-par-1')).toBe('nl-ams-1');
    expect(ScalewayProvider.getDefaultStandbyRegion('nl-ams-2')).toBe('fr-par-2');
  });
});

describe('buildIacEnv — the three-credential seam', () => {
  it('reads the operator SCALEWAY_* companions and EMITS the plugin-native SCW_* triple', () => {
    vi.stubEnv('SCALEWAY_ACCESS_KEY', 'SCWTESTTESTTESTTEST1');
    vi.stubEnv('SCALEWAY_DEFAULT_PROJECT_ID', '11111111-2222-3333-4444-555555555555');
    // Input: the SCALEWAY_SECRET_KEY value (the token) + SCALEWAY_* env.
    // Output: the SCW_* names the Pulumi provider actually reads.
    expect(ScalewayProvider.buildIacEnv('secret-value')).toEqual({
      SCW_SECRET_KEY: 'secret-value',
      SCW_ACCESS_KEY: 'SCWTESTTESTTESTTEST1',
      SCW_DEFAULT_PROJECT_ID: '11111111-2222-3333-4444-555555555555',
    });
  });

  it('throws at deploy START naming the missing companion (access key)', () => {
    vi.stubEnv('SCALEWAY_ACCESS_KEY', undefined);
    vi.stubEnv('SCALEWAY_DEFAULT_PROJECT_ID', '11111111-2222-3333-4444-555555555555');
    expect(() => ScalewayProvider.buildIacEnv('secret-value')).toThrow(/SCALEWAY_ACCESS_KEY/);
  });

  it('throws naming the missing companion (project id)', () => {
    vi.stubEnv('SCALEWAY_ACCESS_KEY', 'SCWTESTTESTTESTTEST1');
    vi.stubEnv('SCALEWAY_DEFAULT_PROJECT_ID', undefined);
    expect(() => ScalewayProvider.buildIacEnv('secret-value')).toThrow(
      /SCALEWAY_DEFAULT_PROJECT_ID/,
    );
  });

  it('throws naming BOTH companions when both are missing — one actionable error, not two rounds', () => {
    vi.stubEnv('SCALEWAY_ACCESS_KEY', undefined);
    vi.stubEnv('SCALEWAY_DEFAULT_PROJECT_ID', undefined);
    expect(() => ScalewayProvider.buildIacEnv('secret-value')).toThrow(
      /SCALEWAY_ACCESS_KEY and SCALEWAY_DEFAULT_PROJECT_ID/,
    );
  });
});

describe('assertAsciiCloudInit — plain-text wire guard', () => {
  it('passes ASCII payloads through unchanged', () => {
    const yaml = '#cloud-config\nruncmd:\n  - [sh, -c, "echo ok"]\n';
    expect(assertAsciiCloudInit(yaml)).toBe(yaml);
  });

  it('refuses non-ASCII bytes loudly, naming the character and offset', () => {
    // Scaleway user data has NO base64 leg (unlike Linode/Vultr) — a
    // non-ASCII byte has no verified fidelity guarantee on the wire.
    expect(() => assertAsciiCloudInit('#cloud-config\n# café\n')).toThrow(/non-ASCII/);
    expect(() => assertAsciiCloudInit('#cloud-config\n# café\n')).toThrow(/é/);
  });
});

describe('label encoding', () => {
  it('round-trips the codebase label set through Scaleway tags', () => {
    const labels = { project: 'testapp-x1', environment: 'prod', role: 'compose' };
    expect(decodeLabels(encodeLabels(labels))).toEqual(labels);
  });

  it("never emits '=' — cannot collide with Scaleway's AUTHORIZED_KEY tag convention", () => {
    expect(encodeLabel('key', 'va=lue')).not.toContain('=');
  });

  it('decodes the known mangled cluster-autoscaler key', () => {
    expect(decodeLabels(['cluster-autoscaler-node:static'])).toEqual({
      'cluster-autoscaler/node': 'static',
    });
  });
});

describe('IP extraction (routed-IP era)', () => {
  it('prefers the inet family from public_ips[]', () => {
    const server = {
      public_ips: [
        { id: 'ip6', family: 'inet6', address: '2001:db8::1' },
        { id: 'ip4', family: 'inet', address: '203.0.113.7' },
      ],
    };
    expect(ScalewayProvider.getPublicIP(server)).toBe('203.0.113.7');
    expect(ScalewayProvider.getPublicIPv6(server)).toBe('2001:db8::1');
  });

  it('falls back to the legacy scalar public_ip', () => {
    expect(ScalewayProvider.getPublicIP({ public_ip: { address: '203.0.113.8' } })).toBe(
      '203.0.113.8',
    );
  });
});

describe('ARM guard', () => {
  type ScwStatics = {
    _typeArch: Record<string, string> | null;
    _locationTypes: Record<string, Set<string>> | null;
    SERVER_TYPES: Record<string, unknown>;
    _prices: unknown;
  };
  const scw = ScalewayProvider as unknown as ScwStatics;
  // A live fetch now also sets _prices; restore it with the rest.
  const saved = {
    typeArch: scw._typeArch,
    locationTypes: scw._locationTypes,
    serverTypes: scw.SERVER_TYPES,
    prices: scw._prices,
  };
  afterEach(() => {
    scw._typeArch = saved.typeArch;
    scw._locationTypes = saved.locationTypes;
    scw.SERVER_TYPES = saved.serverTypes;
    scw._prices = saved.prices;
  });

  // Every arm64 commercial type in the live products/servers catalog
  // (2026-10-16, all nine zones walked), plus the historical COPARM1 line.
  const ARM_TYPES = [
    'BASIC2-A2C-4G',
    'BASIC2-A16C-64G',
    'STANDARD2-A2C-8G',
    'STANDARD2-A64C-256G',
    'COPARM1-2C-8G',
  ];
  // A spread of the x86_64 families from the same catalog, including the
  // shapes most likely to trip a loose name rule.
  const X86_TYPES = [
    'BASIC3-X2C-4G',
    'STANDARD3-X2C-8G',
    'COMPUTE3-X4C-8G',
    'MEMORY3-X2C-16G',
    'POP2-2C-8G',
    'POP2-HC-2C-4G',
    'POP2-HM-2C-16G',
    'DEV1-M',
    'GP1-XS',
    'PLAY2-PICO',
    'PRO2-XXS',
    'L4-1-24G',
    'H100-SXM-2-80G',
    'STARDUST1-S',
  ];

  describe('without a catalog (name rule)', () => {
    it.each(ARM_TYPES)('%s is ARM', (type) => {
      expect(ScalewayProvider.isArmServerType(type)).toBe(true);
    });
    it.each(X86_TYPES)('%s is x86', (type) => {
      expect(ScalewayProvider.isArmServerType(type)).toBe(false);
    });
  });

  describe('with the live catalog (arch field)', () => {
    const catalog = {
      servers: {
        'BASIC3-X2C-4G': { arch: 'x86_64', ncpus: 2, ram: 4 * 2 ** 30 },
        'STANDARD3-X2C-8G': { arch: 'x86_64', ncpus: 2, ram: 8 * 2 ** 30 },
        'STANDARD2-A2C-8G': { arch: 'arm64', ncpus: 2, ram: 8 * 2 ** 30 },
        // An arm64 type whose name the fallback rule would NOT catch: the
        // catalog arch must win over the name.
        'NEWLINE9-Q2C-8G': { arch: 'arm64', ncpus: 2, ram: 8 * 2 ** 30 },
      },
    };
    beforeEach(async () => {
      scw._typeArch = null;
      scw._locationTypes = null;
      fetchWithRetryMock.mockImplementation(async () => jsonResp(catalog));
      expect(await ScalewayProvider.fetchServerTypes('tok')).toBe(true);
    });

    it('classifies by the arch Scaleway reports, not by name', () => {
      expect(ScalewayProvider.isArmServerType('STANDARD2-A2C-8G')).toBe(true);
      expect(ScalewayProvider.isArmServerType('NEWLINE9-Q2C-8G')).toBe(true);
      expect(ScalewayProvider.isArmServerType('BASIC3-X2C-4G')).toBe(false);
      expect(ScalewayProvider.isArmServerType('STANDARD3-X2C-8G')).toBe(false);
    });

    it('still keeps arm64 out of the presented catalog', () => {
      expect(Object.keys(scw.SERVER_TYPES).sort()).toEqual(['BASIC3-X2C-4G', 'STANDARD3-X2C-8G']);
    });

    it('walks each zone servers listing and its availability listing', () => {
      const urls = fetchWithRetryMock.mock.calls.map((c) => String(c[0]));
      for (const zone of Object.keys(ScalewayProvider.REGIONS)) {
        expect(urls).toContain(
          `https://api.scaleway.com/instance/v1/zones/${zone}/products/servers?per_page=100&page=1`,
        );
        expect(urls).toContain(
          `https://api.scaleway.com/instance/v1/zones/${zone}/products/servers/availability?per_page=100&page=1`,
        );
      }
    });

    it('falls back to the name rule for a type the catalog does not list', () => {
      expect(ScalewayProvider.isArmServerType('BASIC2-A2C-4G')).toBe(true);
      expect(ScalewayProvider.isArmServerType('DEV1-M')).toBe(false);
    });

    it('maps STANDARD2-A size-preservingly onto STANDARD3-X when the catalog has it', () => {
      expect(ScalewayProvider.armToAmd64Equivalent('STANDARD2-A2C-8G')).toBe('STANDARD3-X2C-8G');
    });
  });

  it('records no arch map from an incomplete catalog walk', async () => {
    scw._typeArch = null;
    scw._locationTypes = null;
    fetchWithRetryMock.mockImplementation(async () => jsonResp({}, 503));
    expect(await ScalewayProvider.fetchServerTypes('tok')).toBe(false);
    expect(scw._typeArch).toBeNull();
  });

  it('maps BASIC2-A size-preservingly onto BASIC3-X', () => {
    expect(ScalewayProvider.armToAmd64Equivalent('BASIC2-A2C-4G')).toBe('BASIC3-X2C-4G');
    expect(ScalewayProvider.armToAmd64Equivalent('COPARM1-2C-8G')).toBe(
      ScalewayProvider.DEFAULT_TYPE,
    );
  });

  // Every raw-input path (deploy prompt's -server-type and .vibecarbon.json
  // chain, scale -type, failover -server-type and its persisted standby spec,
  // scale/converge's persisted per-role types) calls the polymorphic
  // Provider.assertAmd64ServerType with its own source label. The call sites
  // themselves are pinned in tests/unit/deploy/amd64-only.test.ts.
  it.each([
    '-server-type',
    '.vibecarbon.json serverType',
    '.vibecarbon.json workerServerType',
    '-type',
    '.vibecarbon.json ha.standbyWorkerSpec.serverType',
  ])('rejects STANDARD2-A2C-8G through %s', (source) => {
    expect(() => ScalewayProvider.assertAmd64ServerType('STANDARD2-A2C-8G', source)).toThrow(
      `${source}: 'STANDARD2-A2C-8G' is an ARM (aarch64) Scaleway server type.`,
    );
  });

  it.each(X86_TYPES)('accepts x86 %s on every path', (type) => {
    expect(ScalewayProvider.assertAmd64ServerType(type, '-type')).toBe(type);
  });
});

describe('setFirewallRules — TRUE atomic whole-ruleset replace', () => {
  it('issues exactly ONE PUT to /security_groups/{id}/rules — no delete-then-recreate loop', async () => {
    const provider = new ScalewayProvider('tok');
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body as string });
      if (url.includes('/security_groups/sg-1') && !init?.method) return jsonResp({});
      if (init?.method === 'PUT') return jsonResp({ rules: [] });
      return jsonResp({}, 404);
    });

    await provider.setFirewallRules('sg-1', [
      {
        action: 'accept',
        protocol: 'TCP',
        direction: 'inbound',
        ip_range: '0.0.0.0/0',
        dest_port_from: 443,
        dest_port_to: 443,
      },
    ]);

    const puts = calls.filter((c) => c.method === 'PUT');
    const deletes = calls.filter((c) => c.method === 'DELETE');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toMatch(/\/security_groups\/sg-1\/rules$/);
    expect(deletes).toHaveLength(0);
    expect(posts).toHaveLength(0);

    // Normalization: fresh rules carry id null, sequential positions,
    // editable pinned true (non-editable rules are silently ignored).
    const sent = JSON.parse(puts[0].body ?? '{}');
    expect(sent.rules[0]).toMatchObject({
      id: null,
      position: 1,
      editable: true,
      action: 'accept',
      dest_port_from: 443,
    });
  });
});

describe('applyOperatorCidrs — read-filter-rebuild into one atomic PUT', () => {
  it('rebuilds locked ports as one rule per CIDR, keeps other rules, single PUT', async () => {
    const provider = new ScalewayProvider('tok');
    const existingRules = [
      // locked (SSH) — to be rebuilt
      {
        id: 'r1',
        action: 'accept',
        protocol: 'TCP',
        direction: 'inbound',
        ip_range: '198.51.100.1/32',
        dest_port_from: 22,
        dest_port_to: 22,
      },
      // world HTTP — kept
      {
        id: 'r2',
        action: 'accept',
        protocol: 'TCP',
        direction: 'inbound',
        ip_range: '0.0.0.0/0',
        dest_port_from: 443,
        dest_port_to: 443,
      },
    ];
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body as string });
      if (url.includes('/security_groups?name=')) {
        return jsonResp({ security_groups: [{ id: 'sg-1', name: 'proj-prod-firewall' }] });
      }
      if (url.includes('/security_groups/sg-1/rules') && init?.method === 'PUT') {
        return jsonResp({ rules: [] });
      }
      if (url.includes('/security_groups/sg-1/rules')) {
        return jsonResp({ rules: existingRules });
      }
      if (url.includes('/security_groups/sg-1')) return jsonResp({});
      return jsonResp({}, 404);
    });

    const updated = await provider.applyOperatorCidrs({
      firewallName: 'proj-prod-firewall',
      cidrs: ['203.0.113.5/32', '2001:db8::/64'],
    });
    expect(updated).toBe(true);

    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    const sent = JSON.parse(puts[0].body ?? '{}');
    const sshRules = sent.rules.filter((r: { dest_port_from: number }) => r.dest_port_from === 22);
    expect(sshRules.map((r: { ip_range: string }) => r.ip_range)).toEqual([
      '203.0.113.5/32',
      '2001:db8::/64',
    ]);
    // The world HTTP rule survives untouched (minus its stale id).
    const httpsRule = sent.rules.find((r: { dest_port_from: number }) => r.dest_port_from === 443);
    expect(httpsRule.ip_range).toBe('0.0.0.0/0');
  });
});

describe('deleteServer — billing-leak census (terminate only DETACHES sbs_volume)', () => {
  // Wire fixture: one server in fr-par-1 with an SBS root volume and a
  // flexible IP that survives deletion. The chain must: terminate → wait
  // for 404 → DELETE the block volume → probe + DELETE the surviving IP.
  function wireMocks() {
    const calls: Array<{ url: string; method: string }> = [];
    let serverGone = false;
    const handler = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      // Server GETs: exists until terminated.
      if (/\/instance\/v1\/zones\/fr-par-1\/servers\/srv-1$/.test(url) && method === 'GET') {
        return serverGone
          ? jsonResp({}, 404)
          : jsonResp({
              server: {
                id: 'srv-1',
                zone: 'fr-par-1',
                volumes: { '0': { id: 'vol-1', volume_type: 'sbs_volume' } },
                public_ips: [{ id: 'flexip-1', family: 'inet', address: '203.0.113.9' }],
              },
            });
      }
      // Wrong-zone probes 404.
      if (/\/servers\/srv-1$/.test(url) && method === 'GET') return jsonResp({}, 404);
      if (url.endsWith('/servers/srv-1/action') && method === 'POST') {
        serverGone = true; // terminate accepted
        return jsonResp({ task: { id: 't1' } });
      }
      if (url.includes('/block/v1/zones/fr-par-1/volumes/vol-1') && method === 'DELETE') {
        return jsonResp({}, 204);
      }
      if (url.includes('/ips/flexip-1') && method === 'GET') {
        return jsonResp({ ip: { id: 'flexip-1' } }); // survived — flexible
      }
      if (url.includes('/ips/flexip-1') && method === 'DELETE') {
        return jsonResp({}, 204);
      }
      return jsonResp({}, 404);
    };
    fetchWithRetryMock.mockImplementation(handler);
    // pollUntil's probe uses the raw global fetch.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => handler(String(url), init)),
    );
    return calls;
  }

  it('terminates, deletes the detached SBS volume, and releases the surviving flexible IP', async () => {
    const provider = new ScalewayProvider('tok');
    const calls = wireMocks();

    const result = await provider.deleteServer('srv-1', { waitUntilGone: true });
    expect(result).toBe(true);

    const terminate = calls.find((c) => c.url.endsWith('/servers/srv-1/action'));
    expect(terminate, 'terminate action never fired').toBeDefined();
    const volDelete = calls.find(
      (c) => c.method === 'DELETE' && c.url.includes('/block/v1/zones/fr-par-1/volumes/vol-1'),
    );
    expect(volDelete, 'detached SBS volume was never deleted — this bills forever').toBeDefined();
    const ipDelete = calls.find((c) => c.method === 'DELETE' && c.url.includes('/ips/flexip-1'));
    expect(ipDelete, 'surviving flexible IP was never released — €0.005/hr forever').toBeDefined();
  });

  it('runs the SAME teardown chain in default (non-waitUntilGone) mode — the leak-safety cannot be opted out of', async () => {
    const provider = new ScalewayProvider('tok');
    const calls = wireMocks();

    await provider.deleteServer('srv-1');

    expect(
      calls.some(
        (c) => c.method === 'DELETE' && c.url.includes('/block/v1/zones/fr-par-1/volumes/vol-1'),
      ),
      'default mode skipped the SBS volume delete',
    ).toBe(true);
    expect(
      calls.some((c) => c.method === 'DELETE' && c.url.includes('/ips/flexip-1')),
      'default mode skipped the flexible-IP release',
    ).toBe(true);
  });

  it('returns already-gone semantics without any terminate when no zone has the server', async () => {
    const provider = new ScalewayProvider('tok');
    fetchWithRetryMock.mockResolvedValue(jsonResp({}, 404));

    expect(await provider.deleteServer('srv-x', { waitUntilGone: true })).toBe(false);
    expect(
      fetchWithRetryMock.mock.calls.some(
        (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);
  });
});
