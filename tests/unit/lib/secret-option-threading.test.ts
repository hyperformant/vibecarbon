/**
 * `secret: true` reaches runCommandAsync from every runner a secret read goes
 * through: compose's sshRunAsync, lib/ssh.js's sshRun and sshKubectl, and
 * runKubectlWithRetry on this machine or on a k3s server. runCommandAsync is
 * where the output is held back (command-secret-output.test.ts); a runner
 * that drops the option on the way puts the output back in the CI log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ argv: string[]; opts: { secret?: boolean } }>,
  answer: 'vc-secret-bytes' as string,
}));

vi.mock('../../../src/lib/command.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runCommandAsync: vi.fn(async (argv: string[], opts: { secret?: boolean } = {}) => {
    h.calls.push({ argv, opts });
    return h.answer;
  }),
}));

const { sshRunAsync } = await import('../../../src/lib/deploy/compose/index.js');
const { sshKubectl, sshRun } = await import('../../../src/lib/ssh.js');
const { runKubectlWithRetry } = await import('../../../src/lib/deploy/k8s/k3s.js');

const IP = '203.0.113.9';
const KEY = '/tmp/vc-threading/deploy_key_prod';

beforeEach(() => {
  h.calls.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const secretOf = () => h.calls.map((c) => c.opts.secret);

describe('secret: true reaches runCommandAsync', () => {
  it('through sshRunAsync', async () => {
    await sshRunAsync(IP, KEY, '/bin/bash -s', { input: 'true', secret: true });
    await sshRunAsync(IP, KEY, 'true');
    expect(secretOf()).toEqual([true, undefined]);
  });

  it('through sshRun and sshKubectl', async () => {
    await sshRun(IP, KEY, ['cat', '/opt/shop/.env'], { secret: true });
    await sshKubectl(IP, KEY, ['get', 'secret', 'x', '-o', 'json'], { secret: true });
    await sshRun(IP, KEY, ['true']);
    expect(secretOf()).toEqual([true, true, undefined]);
  });

  it('through runKubectlWithRetry, here and on a k3s server', async () => {
    const env = { KUBECONFIG: '/tmp/vc-threading/kubeconfig' };
    const argv = ['get', 'secret', 'x', '-o', 'json'];
    await runKubectlWithRetry(argv, { env, captureStdout: true, secret: true });
    await runKubectlWithRetry(argv, {
      captureStdout: true,
      secret: true,
      on: { ip: IP, sshKeyPath: KEY },
    });
    await runKubectlWithRetry(argv, { env, captureStdout: true });
    expect(secretOf()).toEqual([true, true, undefined]);
  });

  it('runKubectlWithRetry never streams a secret read to the terminal', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runKubectlWithRetry(['get', 'secret', 'x', '-o', 'json'], { secret: true });
    expect(write.mock.calls.map((c) => String(c[0])).join('')).not.toContain(h.answer);
    // Without secret (and without captureStdout) the output is streamed, as before.
    await runKubectlWithRetry(['get', 'pods'], {});
    expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain(h.answer);
  });
});
