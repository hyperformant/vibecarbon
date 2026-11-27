/**
 * Census: every Vultr resource type a program declares says how a refresh
 * treats it once it is gone.
 *
 * terraform-provider-vultr's Read drops a resource from state only when the
 * API's error contains one exact phrase. For four types that phrase is not
 * what Vultr answers, so the refresh fails on a resource that is already
 * gone (e2e run 45922250720: `error: update failed`, then the destroy's own
 * 404). Each type is classified here as one of:
 *   - VULTR_READ_PRUNES: its Read finds its phrase in Vultr's 404 and drops it;
 *   - VULTR_GONE_PROBES: its Read does not, so pruneVultrGoneResources reads
 *     it by id and drops it on Vultr's own not-found before the refresh.
 *
 * The bodies below are the measured ones (2026-11-27, one GET of a missing id
 * each), so each classification is checked against what Vultr says, not
 * against the code's own idea of it.
 *
 * The declared types are read two ways and joined: every `new <ns>.<Class>(`
 * in src on an `@ediri/vultr` namespace import, and every type the Vultr
 * programs register when RUN under Pulumi's mock runtime. A new type fails
 * until it is classified.
 */
import * as vultr from '@ediri/vultr';
import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it } from 'vitest';
import {
  VULTR_GONE_PROBES,
  VULTR_PROBED_UNDECLARED,
  VULTR_READ_PRUNES,
} from '../../../src/lib/iac/vultr-gone-resources.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import { REPO_ROOT, readRepoFile, sourceFiles } from '../../_shared/source-files.js';

/** Vultr's 404 body for a missing id of each type, as measured on 2026-11-27. */
const MEASURED_404: Record<string, string> = {
  'vultr:index/reservedIp:ReservedIp': '{"error":"reserved ip not found","status":404}',
  'vultr:index/instance:Instance': '{"error":"instance not found","status":404}',
  'vultr:index/vpc:Vpc': '{"is_external_error":false,"error":"VPC not found.","status":404}',
  // Probed under a group that does not exist; a missing rule in a live group
  // was not measured.
  'vultr:index/firewallRule:FirewallRule':
    '{"is_external_error":false,"error":"Firewall Rule Not Found","status":404}',
  'vultr:index/firewallGroup:FirewallGroup':
    '{"is_external_error":false,"error":"Firewall Group Not Found","status":404}',
  'vultr:index/sSHKey:SSHKey': '{"error":"Invalid ssh key.","status":404}',
};

const SDK = vultr as unknown as Record<string, { __pulumiType?: string }>;

/** Every `new <ns>.<Class>(` on an `import * as <ns> from '@ediri/vultr'`, under src. */
function constructedInSource(): Set<string> {
  const types = new Set<string>();
  for (const file of sourceFiles(`${REPO_ROOT}/src`, { exts: ['.js'], relativeTo: REPO_ROOT })) {
    const text = readRepoFile(file);
    for (const [, ns] of text.matchAll(/import \* as (\w+) from '@ediri\/vultr'/g)) {
      for (const [, cls] of text.matchAll(new RegExp(`new ${ns}\\.(\\w+)\\(`, 'g'))) {
        const type = SDK[cls]?.__pulumiType;
        expect(type, `${file}: new ${ns}.${cls} is no @ediri/vultr resource class`).toBeTruthy();
        types.add(type as string);
      }
    }
  }
  return types;
}

const registered = new Set<string>();
let counter = 0;
pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs) {
      counter += 1;
      registered.add(args.type);
      const ip = `203.0.113.${counter % 250}`;
      return {
        id: String(9_000_000 + counter),
        state: { ...args.inputs, mainIp: ip, internalIp: `10.10.0.${counter % 250}` },
      };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  },
  'vibecarbon',
  'test',
);

const common = {
  projectName: 'acme',
  environment: 'prod',
  sshPublicKey: 'ssh-ed25519 AAAAtest test@example.com',
  apiToken: 'test-token-1234',
  allowedSshIps: ['203.0.113.5/32'],
  allowedK8sApiIps: ['203.0.113.5/32'],
  location: 'ewr',
};

/** Run a program to quiescence. */
async function run(program: () => Promise<Record<string, unknown>>) {
  const outputs = await program();
  await new Promise((resolve) => pulumi.all(Object.values(outputs)).apply(resolve));
  for (let seen = -1; seen !== counter; ) {
    seen = counter;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function registeredByPrograms(): Promise<Set<string>> {
  const node = VultrProvider.DEFAULT_K8S_NODE_TYPE as string;
  await run(
    await VultrProvider.getK8sProgram({
      ...common,
      masterServerType: node,
      dbServerType: node,
      workerServerType: node,
      minWorkers: 1,
      maxWorkers: 2,
      k3sVersion: 'v1.37.2+k3s1',
      k3sToken: 'SENTINEL-k3s-token',
      labels: {},
    } as never),
  );
  await run(
    await VultrProvider.getComposeProgram({ ...common, serverType: 'vc2-2c-4gb' } as never),
  );
  return new Set(registered);
}

/** The declared types no list classifies, and the classified ones nothing declares or excuses. */
function census(declared: Set<string>) {
  const probed = Object.keys(VULTR_GONE_PROBES);
  const readPrunes = Object.keys(VULTR_READ_PRUNES);
  const classified = new Set([...probed, ...readPrunes]);
  return {
    unclassified: [...declared].filter((t) => !classified.has(t)).sort(),
    both: probed.filter((t) => readPrunes.includes(t)).sort(),
    stale: [...classified]
      .filter((t) => !declared.has(t) && !(t in VULTR_PROBED_UNDECLARED))
      .sort(),
    excusedButDeclared: Object.keys(VULTR_PROBED_UNDECLARED)
      .filter((t) => declared.has(t))
      .sort(),
  };
}

describe('every Vultr type a program declares is classified for a gone resource', () => {
  it('reads the declared types from source and from the programs, and sees them all', async () => {
    const fromSource = constructedInSource();
    const fromPrograms = await registeredByPrograms();
    // Both reads see every type, so a broken walk cannot pass on nothing.
    for (const type of [
      'vultr:index/instance:Instance',
      'vultr:index/vpc:Vpc',
      'vultr:index/firewallGroup:FirewallGroup',
      'vultr:index/firewallRule:FirewallRule',
      'vultr:index/sSHKey:SSHKey',
    ]) {
      expect(fromSource, `source declares ${type}`).toContain(type);
      expect(fromPrograms, `a program registers ${type}`).toContain(type);
    }
    const declared = new Set(
      [...fromSource, ...fromPrograms].filter((t) => t.startsWith('vultr:')),
    );
    expect(census(declared)).toEqual({
      unclassified: [],
      both: [],
      stale: [],
      excusedButDeclared: [],
    });
  });

  it('bites: a type a program starts declaring is named until it is classified', () => {
    const declared = new Set([
      ...Object.keys(VULTR_READ_PRUNES),
      'vultr:index/instance:Instance',
      'vultr:index/blockStorage:BlockStorage',
    ]);
    expect(census(declared).unclassified).toEqual(['vultr:index/blockStorage:BlockStorage']);
  });

  it('every classified type has a measured 404 body, and every body a classification', () => {
    expect(Object.keys(MEASURED_404).sort()).toEqual(
      [...Object.keys(VULTR_GONE_PROBES), ...Object.keys(VULTR_READ_PRUNES)].sort(),
    );
  });
});

describe("each classification holds against Vultr's measured 404", () => {
  it.each(Object.entries(VULTR_READ_PRUNES))(
    "%s: the provider's Read finds %j in it, so the refresh drops it",
    (type, readLooksFor) => {
      expect(MEASURED_404[type]).toContain(readLooksFor);
    },
  );

  it.each(Object.entries(VULTR_GONE_PROBES))(
    "%s: the provider's Read does not find its phrase, and the prune knows Vultr's own",
    (type, probe) => {
      // Why it is probed: the refresh would fail on it.
      expect(MEASURED_404[type]).not.toContain(probe.readLooksFor);
      // What the prune drops it on: the body's `error`, and nothing else.
      const { error, status } = JSON.parse(MEASURED_404[type]);
      expect(status).toBe(404);
      expect(probe.notFound.test(error)).toBe(true);
      // Another type's not-found is not this one's.
      for (const [other, body] of Object.entries(MEASURED_404)) {
        if (other === type) continue;
        expect(probe.notFound.test(JSON.parse(body).error), `${type} vs ${other}`).toBe(false);
      }
      expect(probe.notFound.test('Not Found')).toBe(false);
    },
  );

  it('the one probed type no program declares says why it stays', () => {
    expect(Object.keys(VULTR_PROBED_UNDECLARED)).toEqual(['vultr:index/reservedIp:ReservedIp']);
    expect(VULTR_PROBED_UNDECLARED['vultr:index/reservedIp:ReservedIp']).toMatch(/never released/);
  });
});
