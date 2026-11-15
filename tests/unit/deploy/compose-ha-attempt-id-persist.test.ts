/**
 * compose-ha keeps what this deploy's skeleton save wrote: the attempt id its
 * add-on job runs with, and the image set it runs.
 *
 * The add-on job stamps its status file with the attempt id it was started
 * with (VC_ATTEMPT_ID), and readers (`vibecarbon status`, the e2e add-on
 * check) trust the file only when it names the env's lastAttemptId. The
 * orchestrator's skeleton save writes this attempt's id; compose-ha's own
 * saves then rebuilt the env from the record as it stood BEFORE the deploy and
 * wrote that record's id back: the previous attempt's, or none on a first
 * deploy. So on compose-ha the status file was never current, every reader
 * fell back to the containers, and a slow image pull read as `stopped`
 * (DigitalOcean compose-ha, GitHub run 43680508383). The same rebuild put
 * the previous deploy's imageSet back, which scale, restore and failover run.
 */
import { describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ config: null as Record<string, unknown> | null }));
vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    loadProjectConfig: () => structuredClone(disk.config),
    updateProjectConfig: (fn: (c: Record<string, unknown>) => unknown) => {
      const current = structuredClone(disk.config ?? {});
      const next = (fn(current) ?? current) as Record<string, unknown>;
      disk.config = next;
      return next;
    },
    registerProject: () => {},
  };
});

const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');

const THIS_ATTEMPT = 'a1b2c3d4e5f6';
const LAST_ATTEMPT = '000000000000';

const envOnDisk = () =>
  (disk.config as { environments: Record<string, Record<string, unknown>> }).environments.prod;

function ctx(envConfig: Record<string, unknown>) {
  return {
    projectConfig: { projectName: 'myapp' },
    environment: 'prod',
    envConfig,
    attemptId: THIS_ATTEMPT,
    region: 'fsn1',
    standbyRegion: 'nbg1',
    serverType: 'cx33',
    standbyServerType: 'cx33',
    primary: { serverId: '1', ip: '10.0.0.1' },
    standby: { serverId: '2', ip: '10.0.0.2' },
    domain: 'prod.dev',
    dnsProvider: 'hetzner',
    services: {},
    s3Config: { bucket: 'myapp-cd9ecc-prod-storage', region: 'fsn1' },
  } as Record<string, unknown>;
}

describe("compose-ha's pending save keeps this attempt's id", () => {
  it('on a redeploy, over the record that names the last attempt', async () => {
    // The skeleton save already wrote this attempt's id to disk.
    disk.config = {
      projectName: 'myapp',
      environments: { prod: { status: 'deploying', lastAttemptId: THIS_ATTEMPT } },
    };
    await COMPOSE_HA_EFFECTS.haPersistPendingConfig(
      ctx({ provider: 'hetzner', lastAttemptId: LAST_ATTEMPT }),
    );
    expect(envOnDisk().lastAttemptId).toBe(THIS_ATTEMPT);
  });

  it('on a first deploy, when the record before it had none', async () => {
    disk.config = {
      projectName: 'myapp',
      environments: { prod: { status: 'deploying', lastAttemptId: THIS_ATTEMPT } },
    };
    await COMPOSE_HA_EFFECTS.haPersistPendingConfig(ctx({ provider: 'hetzner' }));
    expect(envOnDisk().lastAttemptId).toBe(THIS_ATTEMPT);
  });
});

describe("compose-ha's pending save keeps this deploy's image set", () => {
  it('not the one the env recorded before this deploy', async () => {
    const thisSet = { traefik: 'v3.7.19' };
    disk.config = {
      projectName: 'myapp',
      environments: {
        prod: { status: 'deploying', lastAttemptId: THIS_ATTEMPT, imageSet: thisSet },
      },
    };
    await COMPOSE_HA_EFFECTS.haPersistPendingConfig(
      ctx({ provider: 'hetzner', lastAttemptId: LAST_ATTEMPT, imageSet: { traefik: 'v3.7.18' } }),
    );
    expect(envOnDisk().imageSet).toEqual(thisSet);
  });
});
