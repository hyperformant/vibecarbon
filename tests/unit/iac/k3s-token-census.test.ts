import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

/**
 * Census: every k8s program refuses to build without a k3s token. The CLI
 * always passes one, the stack's recorded token or the one it derives from
 * the state passphrase (lib/iac/k3s-token.js), so a program that made its own
 * could only do so when that derivation went missing, and silently: a random
 * token differs from the one a failed earlier up's servers booted with, and
 * no node made after it could join (ruling R23).
 *
 * Walked from PROVIDERS, so a provider that gains the k8s tier is in it, and
 * checked against the k8s programs on disk, so none is left out.
 */

const { created } = vi.hoisted(() => ({
  created: [] as Array<{ type: string; name: string; args: unknown; opts?: unknown }>,
}));
vi.mock('@pulumi/hcloud', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('hcloud', created),
);
vi.mock('@pulumi/digitalocean', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('digitalocean', created),
);
vi.mock('@pulumi/linode', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('linode', created),
);

// A region each k8s provider sells. A provider that gains the k8s tier needs a
// row: the census fails until it has one.
const LOCATION: Record<string, string> = {
  hetzner: 'fsn1',
  digitalocean: 'nyc3',
  linode: 'us-east',
};

const config = (location: string) => ({
  projectName: 'p',
  environment: 'e',
  sshPublicKey: 'ssh-ed25519 AAAA',
  location,
  labels: {},
  allowedSshIps: ['203.0.113.7/32'],
  allowedK8sApiIps: ['203.0.113.7/32'],
  k3sVersion: 'v1.31.0+k3s1',
  masterServerType: 'cx23',
  dbServerType: 'cx23',
  workerServerType: 'cx23',
  minWorkers: 1,
  apiToken: 'SENTINEL-api-token',
  // Sentinel only.
  k3sToken: 'SENTINEL-k3s-token',
});

const k8sProviders = Object.entries(PROVIDERS).filter(([, P]) =>
  (P.SUPPORTED_TIERS as string[]).includes('k8s'),
);

describe('no k8s program makes its own k3s token (census)', () => {
  it('walks every k8s program on disk', () => {
    const files = readdirSync(join(process.cwd(), 'src/lib/iac/programs')).filter((f) =>
      f.endsWith('-k8s.js'),
    );
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(k8sProviders.map(([id]) => `${id}-k8s.js`).sort()).toEqual(files.sort());
  });

  it.each(k8sProviders)('%s: builds with the token it is given', async (id, Provider) => {
    expect(LOCATION[id], `add a region for ${id}`).toBeDefined();
    created.length = 0;
    const program = await Provider.getK8sProgram(config(LOCATION[id]));
    // Non-vacuous: the config is otherwise complete, and the token reaches
    // what the program hands back.
    const outputs = (await program()) as Record<string, unknown>;
    expect(created.length).toBeGreaterThan(0);
    expect(outputs).toHaveProperty('k3sToken');
  });

  it.each(k8sProviders)('%s: refuses to build without a token', async (id, Provider) => {
    for (const k3sToken of [undefined, '']) {
      created.length = 0;
      const { k3sToken: _given, ...rest } = config(LOCATION[id]);
      const withToken = k3sToken === undefined ? rest : { ...rest, k3sToken };
      await expect(Provider.getK8sProgram(withToken)).rejects.toThrow(/k3sToken required/);
      expect(created).toEqual([]);
    }
  });
});
