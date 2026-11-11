/**
 * Resource options of buildLinodeK8sProgram, read back through the Pulumi
 * recorder (Pulumi's own mocks do not expose them).
 */
import { describe, expect, it, vi } from 'vitest';

const { created } = vi.hoisted(() => ({
  created: [] as Array<{ type: string; name: string; args: any; opts?: any }>,
}));
// These tests drive getOrCreateStack against a mocked LocalWorkspace. The real
// state-passphrase check would write a passphrase into the cwd's .env.local and
// .vibecarbon.json, so it is stubbed; state-passphrase-census.test.ts covers
// the real wiring.
vi.mock('../../../src/lib/state-passphrase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/state-passphrase.js')>()),
  ensureStatePassphrase: async () => 'test-passphrase',
}));

vi.mock('@pulumi/linode', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('linode', created),
);

describe('buildLinodeK8sProgram resource options', () => {
  it('replaces the master delete-first so its static addresses are free', async () => {
    const { buildLinodeK8sProgram } = await import('../../../src/lib/iac/programs/linode-k8s.js');
    await buildLinodeK8sProgram({
      projectName: 'acme',
      environment: 'prod',
      sshPublicKey: 'ssh-ed25519 AAAA',
      location: 'us-east',
      masterServerType: 'g6-standard-2',
      dbServerType: 'g6-standard-2',
      workerServerType: 'g6-standard-2',
      minWorkers: 1,
      k3sVersion: 'v1.31.0+k3s1',
      apiToken: 't',
      allowedSshIps: ['203.0.113.5/32'],
      allowedK8sApiIps: ['203.0.113.5/32'],
      k3sToken: 'tok',
    })();
    const master = created.find((r) => r.type === 'linode.Instance' && r.name === 'master');
    expect(master?.opts?.deleteBeforeReplace).toBe(true);
  });
});
