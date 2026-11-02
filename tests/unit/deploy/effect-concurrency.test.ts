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
 * F1 (compose-ha): `haTransferImage` ships the ONE local build to both servers
 * by layer delta, in parallel, WITHOUT awaiting (so it overlaps
 * setupServerFiles → mergeWalgRole → pullImages, as the per-server remote
 * build it replaced did), and `haStartComposeStack` must AWAIT both deliveries
 * before `docker compose up`. A local-mode compose-ha deploy never builds on a
 * server; only direct mode (no local docker) still does.
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
    deliverByTarget: {} as Record<string, Deferred>,
    perf: [] as string[],
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
    return (H.state.deliverByTarget[String(args.sshTarget)] ?? H.state.deliver)?.promise;
  }),
}));

vi.mock('../../../src/lib/perf.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    perfAsync: (name: string, fn: () => unknown) => {
      H.state.perf.push(name);
      return (actual.perfAsync as (n: string, f: () => unknown) => Promise<unknown>)(name, fn);
    },
  };
});

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
  H.state.deliverByTarget = {};
  H.state.perf = [];
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

function composeHaCtx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectConfig: { projectName: 'p' },
    primary: { ip: '1.1.1.1' },
    standby: { ip: '2.2.2.2' },
    sshKeyPath: '/k',
    imageRef: 'p-app:local',
    localImageTag: 'p-app:local',
    isComposeLocal: true,
    isDirectDeploy: false,
    composeLocalBuildPromise: Promise.resolve(),
    domain: null,
    services: {},
    onProgress: () => {},
    ...over,
  };
}

describe('F1 — compose-ha: one local build, a layer delta to both servers, haStartComposeStack is the barrier', () => {
  it('delivers to both servers in parallel without awaiting, and never builds on a server', async () => {
    const ctx = composeHaCtx();
    await COMPOSE_HA_EFFECTS.haTransferImage(ctx);
    expect(ctx.imageTransferPromise).toBeDefined();
    // Both deltas are in flight at once: neither waited for the other.
    await vi.waitFor(() =>
      expect(H.state.order.filter((x) => x === 'deliver-start')).toHaveLength(2),
    );
    expect(H.state.order).not.toContain('build-start');
    expect(H.state.order).not.toContain('reconcile.run');
    // The same tag on both nodes, and it is the APP_IMAGE each node's compose
    // resolves (haServiceOpts stamps ctx.imageRef).
    expect(H.state.deliverArgs.map((a) => a.sshTarget).sort()).toEqual([
      'root@1.1.1.1',
      'root@2.2.2.2',
    ]);
    for (const a of H.state.deliverArgs) {
      expect(a).toMatchObject({
        tag: 'p-app:local',
        sshKey: '/k',
        runtime: 'docker',
        baseRef: 'ghcr.io/o/node-runtime:1',
      });
    }
    // Each server pulls the runtime base itself, before its delta asks what it holds.
    expect(
      H.state.sshCommands.filter((c) => c.includes("docker pull 'ghcr.io/o/node-runtime:1'")),
    ).toHaveLength(2);

    const barrier = COMPOSE_HA_EFFECTS.haStartComposeStack(ctx);
    await tick();
    expect(H.state.order).not.toContain('reconcile.run');
    H.state.deliver?.resolve({ bytes: 1, layersSent: 1, layersReused: 9 });
    await barrier;
    expect(H.state.order.indexOf('reconcile.run')).toBeGreaterThan(
      H.state.order.lastIndexOf('deliver-start'),
    );
    expect(H.state.order).not.toContain('build-start');
  });

  it('waits for the one local build before either delta reads the image', async () => {
    const build = deferred();
    const ctx = composeHaCtx({ composeLocalBuildPromise: build.promise });
    await COMPOSE_HA_EFFECTS.haTransferImage(ctx);
    await tick();
    expect(H.state.order).not.toContain('deliver-start');
    // The base pulls do not wait for the build: they overlap it.
    expect(H.state.order.filter((x) => x === 'basePull:start')).toHaveLength(2);
    build.resolve();
    await vi.waitFor(() =>
      expect(H.state.order.filter((x) => x === 'deliver-start')).toHaveLength(2),
    );
    H.state.deliver?.resolve({});
    await ctx.imageTransferPromise;
  });

  it('a failed delta to one server fails the deploy at the barrier, naming that server, before reconcile', async () => {
    H.state.deliverByTarget['root@2.2.2.2'] = deferred();
    const ctx = composeHaCtx();
    await COMPOSE_HA_EFFECTS.haTransferImage(ctx);
    await vi.waitFor(() =>
      expect(H.state.order.filter((x) => x === 'deliver-start')).toHaveLength(2),
    );
    H.state.deliver?.resolve({});
    H.state.deliverByTarget['root@2.2.2.2'].reject(
      new Error('image delivery failed: the target exited 1'),
    );
    await expect(COMPOSE_HA_EFFECTS.haStartComposeStack(ctx)).rejects.toThrow(
      /standby 2\.2\.2\.2.*image delivery failed: the target exited 1/,
    );
    expect(H.state.order).not.toContain('reconcile.run');
  });

  it('a failed local build fails the deploy at the barrier with its own error', async () => {
    const build = deferred();
    const ctx = composeHaCtx({ composeLocalBuildPromise: build.promise });
    await COMPOSE_HA_EFFECTS.haTransferImage(ctx);
    build.reject(new Error('docker build failed for p-app:local'));
    // The build is this machine's, not a node's: no node prefix on it.
    await expect(COMPOSE_HA_EFFECTS.haStartComposeStack(ctx)).rejects.toThrow(
      /^docker build failed for p-app:local$/,
    );
    expect(H.state.order).not.toContain('deliver-start');
    expect(H.state.order).not.toContain('reconcile.run');
  });

  it('the deltas overlap the stack pull fan in the plan, and reconcile waits for both', async () => {
    const wanted = new Set(['haTransferImage', 'haPullImages', 'haStartComposeStack']);
    const steps = planDeploy('compose-ha', {}).filter((s: { effect: string }) =>
      wanted.has(s.effect),
    );
    expect(steps.map((s: { effect: string }) => s.effect)).toEqual([
      'haTransferImage',
      'haPullImages',
      'haStartComposeStack',
    ]);
    const ctx = composeHaCtx();
    const run = runPlan(steps, ctx, COMPOSE_HA_EFFECTS);
    // The pull fan starts while both deltas are still in flight.
    await vi.waitFor(() => expect(H.state.order).toContain('stackPull:start'));
    expect(H.state.order.filter((x) => x === 'deliver-start')).toHaveLength(2);
    H.state.stackPull?.resolve();
    await tick();
    expect(H.state.order).not.toContain('reconcile.run');
    H.state.deliver?.resolve({});
    await run;
    expect(H.state.order).toContain('reconcile.run');
    expect(H.state.order).not.toContain('build-start');
  });

  it('direct mode (no local docker) still builds on both servers, and reconcile waits for it', async () => {
    const ctx = composeHaCtx({ isComposeLocal: false, isDirectDeploy: true });
    await COMPOSE_HA_EFFECTS.haTransferImage(ctx);
    await vi.waitFor(() =>
      expect(H.state.order.filter((x) => x === 'build-start')).toHaveLength(2),
    );
    expect(H.state.order).not.toContain('deliver-start');
    const barrier = COMPOSE_HA_EFFECTS.haStartComposeStack(ctx);
    await tick();
    expect(H.state.order).not.toContain('reconcile.run');
    H.state.build?.resolve(true);
    await barrier;
    expect(H.state.order).toContain('reconcile.run');
    // Direct mode's markers are remoteBuild's, for the fan and the await alike.
    expect(H.state.perf).toContain('deploy.ha.compose.remoteBuild.fan');
    expect(H.state.perf).toContain('deploy.ha.compose.remoteBuild.await');
    expect(H.state.perf.some((n) => n.includes('imageTransfer'))).toBe(false);
  });

  it('local mode marks the fan and the await as imageTransfer', async () => {
    const ctx = composeHaCtx();
    await COMPOSE_HA_EFFECTS.haTransferImage(ctx);
    H.state.deliver?.resolve({});
    await COMPOSE_HA_EFFECTS.haStartComposeStack(ctx);
    expect(H.state.perf).toContain('deploy.ha.compose.imageTransfer.fan');
    expect(H.state.perf).toContain('deploy.ha.compose.imageTransfer.await');
    expect(H.state.perf.some((n) => n.includes('remoteBuild'))).toBe(false);
  });
});
