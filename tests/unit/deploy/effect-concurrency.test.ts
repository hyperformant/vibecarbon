/**
 * Concurrency/barrier contracts for the compose deploy effects.
 *
 * F2 (compose single): `transferImage` must kick the image transfer off WITHOUT
 * awaiting (so it overlaps the logins + bundle upload), and `startComposeStack`
 * must AWAIT that transfer before `docker compose up` (load-bearing barrier —
 * compose references the app image). The transfer is registry-first (ensure →
 * operator-side tag → SSH-tunnel push → server pull+retag) with a sideload
 * fallback on any failure in that chain — see compose-registry-transfer.test.ts
 * for the success/fallback outcome coverage; this file covers only the overlap
 * timing, for both the registry path and a push-failure-triggered fallback.
 *
 * F1 (compose-ha): `haRemoteBuild` must start the two-node build fan WITHOUT
 * awaiting (so it overlaps setupServerFiles → mergeWalgRole → pullImages), and
 * `haStartComposeStack` must AWAIT the fan before `docker compose up`.
 *
 * We drive real effects with controllable deferred promises for the underlying
 * side-effecting calls (pushImageOverSshTunnel / sideloadCompose / buildRemote /
 * startComposeStack) and assert the ordering: the transfer/build starts, the
 * effect returns while it is still in flight, and reconcile only begins after
 * the barrier releases.
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
    registryPush: null as Deferred | null,
    sideload: null as Deferred | null,
    build: null as Deferred | null,
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

// The registry ensure/tag/server-retag steps are fast preconditions, not the
// thing under test here — they resolve immediately. The push is the in-flight
// long pole, so it alone is a controllable deferred (mirrors sideload below).
// Every named export transferImage destructures must appear here: the
// destructuring sits OUTSIDE the try/catch, so a missing mock export throws
// before the sideload fallback can catch it and the whole promise rejects.
vi.mock('../../../src/lib/deploy/compose/registry.js', () => ({
  ensureComposeRegistry: vi.fn(() => Promise.resolve()),
  REGISTRY_PREFIX: '127.0.0.1:5000/',
  COMPOSE_PUSH_SETTLE_DELAYS_MS: [0, 0, 0],
}));

vi.mock('../../../src/lib/deploy/registry-push.js', () => ({
  pushImageOverSshTunnel: vi.fn(() => {
    H.state.order.push('push-start');
    return H.state.registryPush?.promise;
  }),
}));

vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, runCommandAsync: vi.fn(() => Promise.resolve('')) };
});

vi.mock('../../../src/lib/deploy/image.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    sideloadCompose: vi.fn(() => {
      H.state.order.push('sideload-start');
      return H.state.sideload?.promise;
    }),
  };
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

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    // Server-side pull+retag after a successful push — not the long pole
    // here, so it resolves immediately (fast precondition, like the registry
    // ensure/tag steps above).
    sshRunAsync: vi.fn(() => Promise.resolve('')),
    startComposeStack: vi.fn(async () => {
      H.state.order.push('reconcile-start');
    }),
  };
});

const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');
const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');

// transferImage's compose-local branch dynamically imports these per the
// file's convention (never a top-level import of the compose stack). Pre-warm
// them here so the FIRST call inside a test doesn't pay the module loader's
// first-resolution cost — the in-flight assertions below rely on a fixed
// microtask-tick budget, which a cold `import()` can blow past.
await import('../../../src/lib/deploy/compose/registry.js');
await import('../../../src/lib/deploy/registry-push.js');
await import('../../../src/lib/deploy/compose/index.js');

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  H.state.order = [];
  H.state.registryPush = deferred();
  H.state.sideload = deferred();
  H.state.build = deferred();
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
  };
}

describe('F2 — compose single: transferImage is non-blocking, startComposeStack is the barrier', () => {
  it('kicks the registry push off without awaiting, then reconcile waits for it', async () => {
    const ctx = composeSingleCtx();

    // transferImage returns while the registry push is still in flight. The
    // push sits behind a chain of dynamic imports (the file's convention for
    // the compose stack), so wait for it rather than assuming a fixed
    // microtask-tick budget spans that chain — the negative assertions below
    // stay valid regardless of how long that takes, since nothing downstream
    // can complete while registryPush's deferred is still unresolved.
    await EFFECTS.transferImage(ctx);
    expect(ctx.transferImagePromise).toBeDefined();
    await vi.waitFor(() => expect(H.state.order).toContain('push-start'));
    expect(H.state.order).not.toContain('sideload-start'); // registry path, no fallback
    expect(H.state.order).not.toContain('reconcile-start');

    // The barrier blocks reconcile until the transfer resolves.
    const barrier = EFFECTS.startComposeStack(ctx);
    await tick();
    expect(H.state.order).not.toContain('reconcile-start');

    H.state.registryPush?.resolve();
    await barrier;
    expect(H.state.order).toContain('reconcile-start');
    expect(H.state.order.indexOf('reconcile-start')).toBeGreaterThan(
      H.state.order.indexOf('push-start'),
    );
  });

  it('fallback ordering: a rejected push falls back to sideload, and the barrier still waits for it', async () => {
    const ctx = composeSingleCtx();

    await EFFECTS.transferImage(ctx);
    await vi.waitFor(() => expect(H.state.order).toContain('push-start'));

    // The barrier is already waiting when the push fails.
    const barrier = EFFECTS.startComposeStack(ctx);
    await tick();
    expect(H.state.order).not.toContain('reconcile-start');

    H.state.registryPush?.reject(new Error('push failed'));
    await tick();
    expect(H.state.order).toContain('sideload-start');
    expect(H.state.order).not.toContain('reconcile-start'); // barrier still waiting, now on sideload

    H.state.sideload?.resolve();
    await barrier;
    expect(H.state.order).toContain('reconcile-start');
    expect(H.state.order.indexOf('reconcile-start')).toBeGreaterThan(
      H.state.order.indexOf('sideload-start'),
    );
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
    expect(H.state.order).not.toContain('reconcile-start');

    const barrier = COMPOSE_HA_EFFECTS.haStartComposeStack(ctx);
    await tick();
    expect(H.state.order).not.toContain('reconcile-start');

    H.state.build?.resolve(true);
    await barrier;
    expect(H.state.order).toContain('reconcile-start');
    expect(H.state.order.indexOf('reconcile-start')).toBeGreaterThan(
      H.state.order.indexOf('build-start'),
    );
  });
});
