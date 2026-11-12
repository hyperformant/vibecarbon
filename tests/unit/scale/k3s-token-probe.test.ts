/**
 * `vibecarbon scale` on k8s reads the stack's k3s join token before it
 * resizes anything, through the real converge seam and the real probe
 * classifier. A failed read stops the scale with the probe's message; only a
 * stack the state backend doesn't have builds with a token the stack doesn't
 * record, the one derived from the state passphrase (R22, R23).
 *
 * The Pulumi calls themselves (getStackOutputs, the preview's stack, upStack)
 * and the passphrase resolver are stood in for, so nothing reaches a backend
 * or the repo's .env.local. Sentinels only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const errors: string[] = [];
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    log: {
      info() {},
      warn() {},
      step() {},
      success() {},
      message() {},
      error: (msg: string) => errors.push(msg),
    },
    note() {},
    outro() {},
  };
});

const iac = vi.hoisted(() => ({
  getStackOutputs: vi.fn(),
  upStack: vi.fn(),
  getOrCreateStack: vi.fn(),
  dropRetiredStackResources: vi.fn(),
}));
vi.mock('../../../src/lib/iac/index.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  ...iac,
}));
const PASSPHRASE = 'SENTINEL-passphrase-scale-probe-0000000000000000';
vi.mock('../../../src/lib/state-passphrase.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  ensureStatePassphrase: async () => PASSPHRASE,
}));

const { SCALE_EFFECTS } = await import('../../../src/scale.js');
const { deriveK3sToken } = await import('../../../src/lib/iac/k3s-token.js');
const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');

class ExitError extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const programs: Record<string, unknown>[] = [];
const Provider = {
  getK8sProgram: vi.fn(async (cfg: Record<string, unknown>) => {
    programs.push(cfg);
    return async () => ({});
  }),
  promptObjectStorageCredentials: vi.fn(async () => ({ accessKey: 'AK', secretKey: 'SK' })),
  assertAmd64ServerType: (type: string, source: string) =>
    HetznerProvider.assertAmd64ServerType(type, source),
  K8S_ASSETS: { csiNodeDaemonSet: 'daemonset/hcloud-csi-node' },
};

// A master resize on a single cluster: no CA re-patch, no HA tunnel. The
// environment name can't match a key file in the repo, so no SSH key is read.
const ctx = {
  environment: 'unit-scale-probe-xyz',
  envConfig: { minWorkers: 2, maxWorkers: 5, serverType: 'cx23' },
  projectConfig: { projectName: 'proj', operatorCidrs: [{ cidr: '1.2.3.4/32' }] },
  region: 'fsn1',
  secondaryRegion: undefined,
  isHA: false,
  apiToken: 'tok',
  Provider,
  infraChanges: ['masterType'],
  changes: ['masterType'],
  newValues: { masterType: 'cx33' },
  currentWorkerType: 'cx23',
};

let exitSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors.length = 0;
  programs.length = 0;
  for (const fn of Object.values(iac)) fn.mockReset();
  iac.getOrCreateStack.mockResolvedValue({ name: 'unit-scale-probe-xyz', preview: vi.fn() });
  iac.dropRetiredStackResources.mockResolvedValue({ removed: [], addresses: [], deployment: null });
  iac.upStack.mockResolvedValue({ outputs: { masterIp: '1.2.3.4' }, summary: {} });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);
});
afterEach(() => {
  exitSpy.mockRestore();
});

describe('scale stops when it cannot read the k3s join token', () => {
  it.each([
    ['the state backend is unreachable', 'NoSuchBucket: state backend gone'],
    [
      'backpressure retries ran out',
      'error: blob (code=Unknown): SlowDown: Please reduce your request rate.',
    ],
  ])('%s: exit 1 with the reason, before any resize', async (_label, message) => {
    iac.getStackOutputs.mockRejectedValue(new Error(message));

    await expect(SCALE_EFFECTS.scaleApplyK8sChanges(ctx)).rejects.toThrow(ExitError);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const said = errors.join('\n');
    expect(said).toContain(
      `Couldn't read your k3s join token for unit-scale-probe-xyz from its Pulumi state: ${message.replace(/\.$/, '')}.`,
    );
    expect(said).toContain('You can run this again safely.');
    // No program was built: no token went anywhere.
    expect(programs).toHaveLength(0);
    expect(iac.upStack).not.toHaveBeenCalled();
  });

  it('a stack the backend does not have: the derived token, never a random one', async () => {
    const notFound = Object.assign(new Error('Pulumi stack "unit-scale-probe-xyz" was not found'), {
      stackNotFound: true,
    });
    iac.getStackOutputs.mockRejectedValue(notFound);

    await SCALE_EFFECTS.scaleApplyK8sChanges(ctx);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(programs).toHaveLength(1);
    expect(programs[0].k3sToken).toBe(
      deriveK3sToken({
        passphrase: PASSPHRASE,
        projectName: 'proj',
        stackName: 'unit-scale-probe-xyz',
      }),
    );
    expect(programs[0].k3sTokenReplayed).toBe(false);
    expect(iac.upStack).toHaveBeenCalledTimes(1);
  });
});
