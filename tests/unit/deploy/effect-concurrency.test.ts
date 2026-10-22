/**
 * Concurrency/barrier contracts for the compose deploy effects.
 *
 * F2 (compose single): `transferImage` must kick the image delivery off WITHOUT
 * awaiting (so it overlaps the logins + bundle upload), and `startComposeStack`
 * must AWAIT it before `docker compose up` (load-bearing barrier: compose
 * references the app image). The delivery is a layer delta (deliverImage,
 * layer-delta.js): the server pulls the runtime base the project's Dockerfile
 * names (`ARG RUNTIME_IMAGE=`) at datacenter speed while the host saves the
 * image, and the delta carries only the app's own layers. No registry, no
 * whole-image fallback.
 *
 * Stack pulls (cold-deploy-speed plan, Task 4): `setupServerFiles` starts the
 * stack's image pull (every service but `app`) in the background once the
 * bundle's compose files are on the server, and `startComposeStack` awaits it
 * before reconcile, so the pulls overlap the image transfer, DNS and restore-tls
 * instead of running inside `compose up`. The pull never moves into
 * cloud-init (cloud-init-no-image-pull.test.ts).
 *
 * F1 (compose-ha): `haRemoteBuild` must start the two-node build fan WITHOUT
 * awaiting (so it overlaps setupServerFiles → mergeWalgRole → pullImages), and
 * `haStartComposeStack` must AWAIT the fan before `docker compose up`.
 *
 * We drive real effects with controllable deferred promises for the underlying
 * side-effecting calls (deliverImage / the base pull / pullComposeImages /
 * buildRemote / startComposeStack) and assert the ordering.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred = {
  promise: Promise<unknown>;
  resolve: (v?: unknown) => void;
  reject: (e?: unknown) => void;
};

const H = vi.hoisted(() => ({
  state: {
    order: [] as string[],
    deliver: null as Deferred | null,
    basePull: null as Deferred | null,
    stackPull: null as Deferred | null,
    build: null as Deferred | null,
    baseRef: 'ghcr.io/o/node-runtime:1' as string | null,
    sshCommands: [] as string[],
    deliverArgs: [] as Record<string, unknown>[],
  },
}));

function deferred(): Deferred {
  let resolve!: (v?: unknown) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

vi.mock('../../../src/lib/deploy/layer-delta.js', () => ({
  deliverImage: vi.fn((args: Record<string, unknown>) => {
    H.state.order.push('deliver-start');
    H.state.deliverArgs.push(args);
    return H.state.deliver?.promise;
  }),
}));

vi.mock('../../../src/lib/deploy/image.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, readRuntimeBaseRef: vi.fn(() => H.state.baseRef) };
});

vi.mock('../../../src/lib/deploy/remote-build.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    buildRemote: vi.fn(() => {
      H.state.order.push('build-start');
      return H.state.build?.promise;
    }),
  };
});

vi.mock('../../../src/lib/deploy/compose/build-args.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, collectComposeBuildArgs: vi.fn(() => ({})) };
});

vi.mock('../../../src/lib/deploy/digest.js', () => ({ digestDir: vi.fn(() => 'digest') }));

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    sshRunAsync: vi.fn((_ip: string, _key: string, cmd: string) => {
      H.state.sshCommands.push(cmd);
      if (cmd.includes('docker pull ')) {
        H.state.order.push('basePull:start');
        return H.state.basePull?.promise;
      }
      return Promise.resolve('');
    }),
    setupServerFiles: vi.fn(async () => {
      H.state.order.push('setup-server-files:bundle');
    }),
    pullComposeImages: vi.fn(() => {
      H.state.order.push('stackPull:start');
      return H.state.stackPull?.promise.then(() => {
        H.state.order.push('stackPull:awaited');
      });
    }),
    startComposeStack: vi.fn(async () => {
      H.state.order.push('reconcile.run');
    }),
  };
});

const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');
const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');
const { planDeploy } = await import('../../../src/lib/deploy/plan/deploy-plan.js');
const { runPlan } = await import('../../../src/lib/deploy/plan/runner.js');

// transferImage's compose-local branch dynamically imports these per the
// file's convention (never a top-level import of the compose stack). Pre-warm
// them here so the FIRST call inside a test doesn't pay the module loader's
// first-resolution cost.
await import('../../../src/lib/deploy/layer-delta.js');
await import('../../../src/lib/deploy/compose/index.js');

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  H.state.order = [];
  H.state.sshCommands = [];
  H.state.deliverArgs = [];
  H.state.baseRef = 'ghcr.io/o/node-runtime:1';
  H.state.deliver = deferred();
  H.state.basePull = deferred();
  H.state.stackPull = deferred();
  H.state.build = deferred();
});

const fakeState = () => ({
  shouldSkip: () => false,
  startStep: () => {},
  completeStep: () => {},
});

function composeSingleCtx(): Record<string, unknown> {
  return {
    isComposeLocal: true,
    isDirectDeploy: false,
    composeLocalBuildPromise: Promise.resolve(),
    localImageTag: 'p-app:local',
    serverIp: '1.1.1.1',
    sshKeyPath: '/k',
    projectConfig: { projectName: 'p' },
    services: {},
    domain: null,
    state: fakeState(),
    bundlePath: '/bundle',
  };
}

describe('F2 — compose single: transferImage is non-blocking, startComposeStack is the barrier', () => {
  it('kicks the layer delta off without awaiting, then reconcile waits for it', async () => {
    const ctx = composeSingleCtx();

    await EFFECTS.transferImage(ctx);
    expect(ctx.transferImagePromise).toBeDefined();
    await vi.waitFor(() => expect(H.state.order).toContain('deliver-start'));
    expect(H.state.order).not.toContain('reconcile.run');

    const barrier = EFFECTS.startComposeStack(ctx);
    await tick();
    expect(H.state.order).not.toContain('reconcile.run');

    H.state.deliver?.resolve({ bytes: 1, layersSent: 1, layersReused: 9 });
    await barrier;
    expect(H.state.order.indexOf('reconcile.run')).toBeGreaterThan(
      H.state.order.indexOf('deliver-start'),
    );
  });

  it('starts docker pull <baseRef> on the server and passes that promise as basePull', async () => {
    const ctx = composeSingleCtx();
    await EFFECTS.transferImage(ctx);
    await vi.waitFor(() => expect(H.state.order).toContain('deliver-start'));

    // The pull starts before the delivery (it overlaps the host-side save).
    expect(H.state.order.indexOf('basePull:start')).toBeLessThan(
      H.state.order.indexOf('deliver-start'),
    );
    // Inspect first: the ref is immutable, so a server that holds it (every
    // warm redeploy) asks no registry, and a GHCR blip cannot fail it.
    expect(H.state.sshCommands).toContain(
      "docker image inspect 'ghcr.io/o/node-runtime:1' >/dev/null 2>&1 || docker pull 'ghcr.io/o/node-runtime:1'",
    );
    const [args] = H.state.deliverArgs;
    expect(args).toMatchObject({
      tag: 'p-app:local',
      sshTarget: 'root@1.1.1.1',
      sshKey: '/k',
      runtime: 'docker',
      baseRef: 'ghcr.io/o/node-runtime:1',
    });
    // The very promise the pull returned, so deliverImage awaits the real pull.
    H.state.basePull?.resolve('pulled');
    await expect(args.basePull).resolves.toBe('pulled');
  });

  it('a Dockerfile with no RUNTIME_IMAGE ARG means no base pull: the delta sends every layer', async () => {
    H.state.baseRef = null;
    const ctx = composeSingleCtx();
    await EFFECTS.transferImage(ctx);
    await vi.waitFor(() => expect(H.state.order).toContain('deliver-start'));
    expect(H.state.sshCommands.some((c) => c.includes('docker pull'))).toBe(false);
    const [args] = H.state.deliverArgs;
    expect(args.basePull).toBeUndefined();
    expect(args.baseRef).toBe('');
  });

  it('a failed base pull with the build still running is no unhandled rejection', async () => {
    const build = deferred();
    const ctx = { ...composeSingleCtx(), composeLocalBuildPromise: build.promise };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await EFFECTS.transferImage(ctx);
      H.state.basePull?.reject(new Error('denied'));
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      build.resolve();
    }
  });
});

describe('stack pulls overlap the transfer (cold-deploy-speed Task 4)', () => {
  /** The compose plan's own order, cut to the three effects under test. */
  async function runComposePlanWithFakes(): Promise<string[]> {
    const wanted = new Set(['transferImage', 'setupServerFiles', 'startComposeStack']);
    const steps = planDeploy('compose', {}).filter((s: { effect: string }) => wanted.has(s.effect));
    const ctx = composeSingleCtx();
    const run = runPlan(steps, ctx, EFFECTS);
    await vi.waitFor(() => expect(H.state.order).toContain('stackPull:start'));
    H.state.deliver?.resolve({ bytes: 1, layersSent: 1, layersReused: 0 });
    await tick();
    // The transfer is done, but reconcile still waits on the stack pull.
    expect(H.state.order).not.toContain('reconcile.run');
    H.state.stackPull?.resolve();
    await run;
    return H.state.order;
  }

  it('starts after the bundle lands and is awaited before reconcile', async () => {
    const order = await runComposePlanWithFakes();
    expect(order.indexOf('stackPull:start')).toBeGreaterThan(
      order.indexOf('setup-server-files:bundle'),
    );
    expect(order.indexOf('stackPull:awaited')).toBeLessThan(order.indexOf('reconcile.run'));
  });

  it('setupServerFiles returns while the pull is still running', async () => {
    const ctx = composeSingleCtx();
    await EFFECTS.setupServerFiles(ctx);
    expect(H.state.order).toEqual(['setup-server-files:bundle', 'stackPull:start']);
    expect(H.state.order).not.toContain('stackPull:awaited');
    expect(ctx.stackPullPromise).toBeDefined();
    H.state.stackPull?.resolve();
  });

  it('a failed stack pull fails the deploy at the barrier, before reconcile', async () => {
    const ctx = composeSingleCtx();
    await EFFECTS.setupServerFiles(ctx);
    H.state.stackPull?.reject(new Error('toomanyrequests'));
    await expect(EFFECTS.startComposeStack(ctx)).rejects.toThrow(/toomanyrequests/);
    expect(H.state.order).not.toContain('reconcile.run');
  });
});

describe('F1 — compose-ha: haRemoteBuild is non-blocking, haStartComposeStack is the barrier', () => {
  it('starts the two-node build fan without awaiting, then reconcile waits for it', async () => {
    const ctx: Record<string, unknown> = {
      projectConfig: { projectName: 'p' },
      primary: { ip: '1.1.1.1' },
      standby: { ip: '2.2.2.2' },
      sshKeyPath: '/k',
      imageRef: 'p-app:local',
      domain: null,
      services: {},
      isLocalOnlyImage: true,
      onProgress: () => {},
    };

    await COMPOSE_HA_EFFECTS.haRemoteBuild(ctx);
    // Both nodes' builds kicked off; the effect returned while they run.
    expect(H.state.order.filter((x) => x === 'build-start')).toHaveLength(2);
    expect(ctx.remoteBuildPromise).toBeDefined();
    expect(H.state.order).not.toContain('reconcile.run');

    const barrier = COMPOSE_HA_EFFECTS.haStartComposeStack(ctx);
    await tick();
    expect(H.state.order).not.toContain('reconcile.run');

    H.state.build?.resolve(true);
    await barrier;
    expect(H.state.order).toContain('reconcile.run');
    expect(H.state.order.indexOf('reconcile.run')).toBeGreaterThan(
      H.state.order.indexOf('build-start'),
    );
  });
});
