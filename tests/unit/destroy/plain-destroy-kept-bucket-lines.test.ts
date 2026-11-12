/**
 * A plain destroy keeps the app bucket and the Pulumi state bucket, and each
 * kept line names what can delete it. Which path works depends on the
 * entry, and the keep rule is final when the bucket steps run:
 *
 * - While the destroy keeps the entry, a clean `vibecarbon destroy <env>
 *   -purge` reaches the buckets, so the line names that command.
 * - Once the destroy moves the entry to destroyedEnvironments, that command
 *   stops at "Environment not found". The app bucket line gives the console
 *   steps (and says a redeploy reuses it); the state bucket line names the
 *   -purge of the project's last environment.
 *
 * The lines used to end "(delete with -purge)" in both cases. The steps run
 * here in their plan order (destroy-plan.js composeTail).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { projectConfigStore } from '../helpers/project-config-store.js';

const APP = 'myapp-cd9ecc-staging-storage';
const LEGACY = 'myapp-cd9ecc-storage';
const STATE = 'myapp-cd9ecc-storage-pulumi-state-aaaaaa';
const BACKUPS = 'myapp-cd9ecc-fsn1-backups';
/** entryKeptReason's words for a server the teardown could not delete. */
const BECAUSE = 'the leak report lists what a re-run can still find and remove (server)';

const store = projectConfigStore();
const promptCreds = vi.fn(async () => ({ accessKey: 'ak', secretKey: 'sk' }));
const s3 = {
  deletePrefix: vi.fn(async () => ({ objectsRemoved: 4 })),
  emptyAndDeleteBucket: vi.fn(async () => ({ deleted: true, objectsRemoved: 2, warnings: [] })),
  locateBucket: vi.fn(async (): Promise<string | null> => null),
  addressableRegions: vi.fn(() => ['fsn1', 'nbg1', 'hel1']),
  forRegion: vi.fn(() => s3),
};

vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    updateProjectConfig: (fn: (c: Record<string, unknown>) => unknown) =>
      store.updateProjectConfig(fn),
  };
});

vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    providerFor: () => ({ NAME: 'Hetzner Cloud', promptObjectStorageCredentials: promptCreds }),
    getObjectStorageProvider: async () => s3,
  };
});

const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');

function liveEnv(name: string, s3Extra: Record<string, unknown> = {}) {
  return {
    provider: 'hetzner',
    envName: name,
    deployMode: 'compose',
    status: 'deployed',
    s3: { bucket: `myapp-cd9ecc-${name}-storage`, stateBucket: STATE, region: 'fsn1', ...s3Extra },
    backupS3: { bucket: BACKUPS, region: 'fsn1' },
  };
}

/**
 * A plain destroy of staging. `kept` puts a line a rerun can act on in the
 * ledger, as a teardown that could not delete a server leaves: the entry is
 * kept. `prod` adds a second live environment. `s3` overrides staging's
 * app bucket record.
 */
function plainDestroy({
  kept = false,
  prod = false,
  s3: s3Extra = {},
}: {
  kept?: boolean;
  prod?: boolean;
  s3?: Record<string, unknown>;
} = {}) {
  const projectConfig = {
    projectName: 'myapp',
    bucketSalt: 'cd9ecc',
    stateBucketGeneration: 'aaaaaa',
    environments: {
      staging: liveEnv('staging', s3Extra),
      ...(prod ? { prod: liveEnv('prod') } : {}),
    } as Record<string, ReturnType<typeof liveEnv>>,
  };
  store.reset(structuredClone(projectConfig));
  const leaks = createLeakLedger();
  if (kept) {
    leaks.leak({
      resourceClass: 'server',
      resource: 'myapp-staging-master',
      reason: 'delete failed: 503',
      hint: 'Delete it via the Hetzner Cloud console.',
    });
  }
  const stops: string[] = [];
  const ctx = {
    plan: { tier: 'compose', stackEnvs: ['staging'] },
    envConfig: projectConfig.environments.staging,
    projectConfig,
    environment: 'staging',
    args: {},
    results: { leaks, pulumiDestroyFailed: false } as Record<string, unknown> & {
      leaks: ReturnType<typeof createLeakLedger>;
    },
    spinner: { start: () => {}, stop: (m?: string) => stops.push(m ?? ''), message: () => {} },
    isK8s: false,
  };
  return { ctx, stops };
}

/** The bucket steps and the config write, in their plan order. */
async function bucketTail(ctx: ReturnType<typeof plainDestroy>['ctx']) {
  await DESTROY_EFFECTS.deleteAppBucket(ctx);
  await DESTROY_EFFECTS.retainStateBucket(ctx);
  await DESTROY_EFFECTS.handleBackupBucket(ctx);
  await DESTROY_EFFECTS.updateProjectConfig(ctx);
}

type Saved = {
  environments: Record<string, unknown>;
  destroyedEnvironments?: Record<string, unknown>;
};
const onDisk = () => (store.lastWrite() ?? store.state.disk) as unknown as Saved;
const appLine = (stops: string[]) => stops.find((s) => s.startsWith('S3 bucket kept')) ?? '';
const stateLine = (stops: string[]) =>
  stops.find((s) => s.startsWith('Pulumi state bucket kept')) ?? '';

describe('a plain destroy names what deletes each bucket it keeps', () => {
  beforeEach(() => {
    store.reset();
    promptCreds.mockClear();
    s3.deletePrefix.mockClear();
    s3.emptyAndDeleteBucket.mockClear();
  });

  it('while the entry is kept, both lines name the clean -purge rerun', async () => {
    const { ctx, stops } = plainDestroy({ kept: true });
    await bucketTail(ctx);

    expect(Object.keys(onDisk().environments)).toContain('staging');
    expect(appLine(stops)).toBe(
      `S3 bucket kept with its uploads: ${APP}. This destroy keeps staging's entry because ` +
        `${BECAUSE}, so a clean ` +
        '`vibecarbon destroy staging -purge` deletes it.',
    );
    expect(stateLine(stops)).toContain(
      `This destroy keeps staging's entry because ${BECAUSE}, so a clean ` +
        '`vibecarbon destroy staging -purge` deletes it.',
    );
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
  });

  it('once the entry moves, the app line gives the console steps and names no destroy', async () => {
    const { ctx, stops } = plainDestroy();
    await bucketTail(ctx);

    // The premise: `destroy staging -purge` would now stop at "not found".
    expect(Object.keys(onDisk().environments)).not.toContain('staging');
    expect(Object.keys(onDisk().destroyedEnvironments ?? {})).toContain('staging');

    const line = appLine(stops);
    expect(line).toBe(
      `S3 bucket kept with its uploads: ${APP}. A redeploy of staging reuses it. This destroy ` +
        'moves staging out of your environments, so no later destroy reaches the bucket: to ' +
        'delete it, empty it via the Hetzner Cloud Object Storage console, then DeleteBucket; ' +
        'it keeps billing until removed.',
    );
    expect(line).not.toMatch(/vibecarbon destroy|with -purge/);
    expect(promptCreds).not.toHaveBeenCalled();
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
  });

  it('once the last entry moves, the state line waits for a deploy and names no destroy of it', async () => {
    const { ctx, stops } = plainDestroy();
    await bucketTail(ctx);

    const line = stateLine(stops);
    expect(line).toBe(
      `Pulumi state bucket kept for reuse: ${STATE} (recorded as retainedStateBucket; the next ` +
        'deploy resumes this warm state backend). No environment is left to destroy, so it ' +
        "waits for your next deploy; a -purge destroy of the project's last environment " +
        'deletes it then.',
    );
    expect(line).not.toMatch(/vibecarbon destroy|with -purge|console/);
  });

  it('with another live environment, the state line names it and the last environment’s -purge', async () => {
    const moved = plainDestroy({ prod: true });
    await bucketTail(moved.ctx);
    expect(stateLine(moved.stops)).toContain(
      "prod still uses it, so a -purge destroy of the project's last environment deletes it.",
    );
    expect(stateLine(moved.stops)).not.toMatch(/vibecarbon destroy|with -purge/);

    // A kept entry's -purge rerun would keep the bucket for prod, so the
    // line does not offer it.
    const kept = plainDestroy({ prod: true, kept: true });
    await bucketTail(kept.ctx);
    expect(stateLine(kept.stops)).toContain(
      "prod still uses it, so a -purge destroy of the project's last environment deletes it.",
    );
    expect(stateLine(kept.stops)).not.toContain('vibecarbon destroy staging');
    // The app bucket is staging's own, so its kept rerun does delete it.
    expect(appLine(kept.stops)).toContain(
      'a clean `vibecarbon destroy staging -purge` deletes it.',
    );
  });

  it('a pinned or legacy app bucket is named as one no -purge deletes', async () => {
    const pinned = plainDestroy({ s3: { bucketPin: true } });
    await bucketTail(pinned.ctx);
    expect(appLine(pinned.stops)).toBe(
      `S3 bucket kept (pinned): ${APP}. A pinned bucket may serve other environments; delete it manually if nothing uses it anymore.`,
    );

    const legacy = plainDestroy({ s3: { bucket: LEGACY } });
    await bucketTail(legacy.ctx);
    expect(appLine(legacy.stops)).toBe(
      `S3 bucket kept: ${LEGACY}. It is the legacy per-project bucket, which other environments may still use; delete it manually if nothing uses it anymore.`,
    );
    for (const stops of [pinned.stops, legacy.stops]) {
      expect(appLine(stops)).not.toContain('-purge');
    }
  });
});
