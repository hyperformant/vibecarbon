/**
 * `iter-step <rig> destroy -purge` must clean up as the lifecycle's own final
 * cleanup does. It used to stop at the destroy: on Linode, 2026-11-08, two
 * torn-down rigs left their unread CSI volumes and their public test repos
 * behind with nothing to say so, because only the runner swept. These drive
 * finishRigTeardown (tests/e2e/utils/rig-teardown.ts) with each outcome; no
 * cloud, no gh, no docker.
 */
import { describe, expect, it, vi } from 'vitest';
import { finishRigTeardown } from '../../e2e/utils/rig-teardown.js';

const clean = () => ({
  servers: 0,
  volumes: 0,
  placementGroups: 0,
  firewalls: 0,
  floatingIps: 0,
  networks: 0,
  s3Buckets: 0,
  sshKeys: 0,
});

const RIG = { provider: 'linode', projectName: 'testapp-k8s-1-abc', repoSlug: 'vc-e2e-k8s-abc' };
const RIG_PATH = '/repo/tests/results/.rig-linode-k8s.json';
const ENV = { LINODE_API_TOKEN: 'linode-token', HETZNER_API_TOKEN: 'hetzner-token' };

function harness(sweepResult = { counts: clean(), enumFailed: false }) {
  const deps = {
    sweep: vi.fn(async () => sweepResult),
    deleteRepo: vi.fn(async (_slug: string) => {}),
    reap: vi.fn(async (_tag: string, _projectName: string) => {}),
    removeRigFile: vi.fn((_path: string) => {}),
  };
  const lines: string[] = [];
  const run = (destroyExit: number, over: { rig?: object; env?: object } = {}) =>
    finishRigTeardown({
      rig: { ...RIG, ...over.rig },
      rigPath: RIG_PATH,
      destroyExit,
      env: (over.env as Record<string, string>) ?? ENV,
      log: (line) => lines.push(line),
      deps,
    });
  return { deps, lines, run };
}

describe('finishRigTeardown', () => {
  it('a clean destroy is swept, its repo and images removed, and the rig file deleted', async () => {
    const h = harness();
    expect(await h.run(0)).toEqual({ verdict: 'PASS', exitCode: 0 });
    expect(h.deps.sweep).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'linode',
        projectName: 'testapp-k8s-1-abc',
        token: 'linode-token',
      }),
    );
    expect(h.deps.deleteRepo).toHaveBeenCalledWith('vc-e2e-k8s-abc');
    expect(h.deps.reap).toHaveBeenCalledWith('[iter]', 'testapp-k8s-1-abc');
    expect(h.deps.removeRigFile).toHaveBeenCalledWith(RIG_PATH);
  });

  it('what the sweep finds is a leak the destroy left: LEAKED, exit 2, named', async () => {
    const h = harness({ counts: { ...clean(), volumes: 2 }, enumFailed: false });
    expect(await h.run(0)).toEqual({ verdict: 'LEAKED', exitCode: 2 });
    expect(h.lines.join('\n')).toMatch(/LEAK: the destroy left 2 resource\(s\).*"volumes":2/);
    // The sweep deleted them, so nothing of the rig is left.
    expect(h.deps.removeRigFile).toHaveBeenCalled();
  });

  it('a sweep that could not read every list is UNVERIFIED and keeps the rig file', async () => {
    const h = harness({ counts: clean(), enumFailed: true });
    expect(await h.run(0)).toEqual({ verdict: 'UNVERIFIED', exitCode: 2 });
    expect(h.deps.removeRigFile).not.toHaveBeenCalled();
  });

  it('a destroy that left resources stays LEAKED even when the sweep finds none', async () => {
    const h = harness();
    expect(await h.run(2)).toEqual({ verdict: 'LEAKED', exitCode: 2 });
    expect(h.deps.sweep).toHaveBeenCalled();
  });

  it('a destroy that crashed keeps everything for the operator to read', async () => {
    const h = harness();
    expect(await h.run(1)).toEqual({ verdict: 'FAIL', exitCode: 1 });
    expect(h.deps.sweep).not.toHaveBeenCalled();
    expect(h.deps.deleteRepo).not.toHaveBeenCalled();
    expect(h.deps.reap).not.toHaveBeenCalled();
    expect(h.deps.removeRigFile).not.toHaveBeenCalled();
  });

  it("never borrows another provider's token: no token, no sweep, UNVERIFIED", async () => {
    const h = harness();
    const out = await h.run(0, { env: { HETZNER_API_TOKEN: 'hetzner-token' } });
    expect(out).toEqual({ verdict: 'UNVERIFIED', exitCode: 2 });
    expect(h.deps.sweep).not.toHaveBeenCalled();
    expect(h.lines.join('\n')).toContain('LINODE_API_TOKEN');
    expect(h.deps.removeRigFile).not.toHaveBeenCalled();
  });

  it('a repo that cannot be deleted is a note, not a failed teardown', async () => {
    const h = harness();
    h.deps.deleteRepo.mockRejectedValueOnce(new Error('HTTP 403: delete_repo scope\nmore'));
    expect(await h.run(0)).toEqual({ verdict: 'PASS', exitCode: 0 });
    expect(h.lines.join('\n')).toContain(
      'could not delete the test repo vc-e2e-k8s-abc (non-fatal): HTTP 403: delete_repo scope',
    );
  });

  it('a rig without a repo deletes none', async () => {
    const h = harness();
    await h.run(0, { rig: { repoSlug: null } });
    expect(h.deps.deleteRepo).not.toHaveBeenCalled();
  });
});
