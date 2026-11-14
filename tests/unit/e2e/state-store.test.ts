/** The e2e state bucket as a store: named by the shared resolver, never hardcoded. */
import { HeadBucketCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import {
  e2eStateStore,
  ownsStaleScratchProject,
  type S3Config,
} from '../../e2e/utils/state-store.js';

const notFound = () =>
  Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
const HETZNER_ENV = { HETZNER_ACCESS_KEY: 'a', HETZNER_SECRET_KEY: 's' };

/** A fake S3 where the bucket lives in `at`; every other region answers 404. */
function fakeS3(at: string, sent: Array<{ region: string; name: string; input: unknown }> = []) {
  const cfgs: S3Config[] = [];
  const s3 = (cfg: S3Config) => {
    cfgs.push(cfg);
    return {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push({ region: cfg.region, name: cmd.constructor.name, input: cmd.input });
        if (cmd instanceof HeadBucketCommand) {
          if (cfg.region === at) return {};
          throw notFound();
        }
        if (cmd instanceof ListObjectsV2Command) return { Contents: [{ Key: 'k1' }] };
        return {};
      },
    };
  };
  return { s3, cfgs, sent };
}

describe('e2eStateStore', () => {
  it('names the bucket through the shared resolver', async () => {
    const local = fakeS3('nbg1');
    const ls = e2eStateStore(
      'hetzner',
      { ...HETZNER_ENV, VC_E2E_STATE_BUCKET: 'vc-e2e-state-local-xyz' },
      { s3: local.s3 },
    );
    expect(await ls?.where()).toEqual({
      bucket: 'vc-e2e-state-local-xyz',
      region: 'nbg1',
      endpoint: 'https://nbg1.your-objectstorage.com',
    });

    const ci = fakeS3('fsn1');
    const cs = e2eStateStore(
      'hetzner',
      { ...HETZNER_ENV, E2E_NAMESPACE: 'ci', VC_E2E_STATE_BUCKET: 'vc-e2e-state-ci-xyz' },
      { s3: ci.s3 },
    );
    expect(await cs?.where()).toEqual({
      bucket: 'vc-e2e-state-ci-xyz',
      region: 'fsn1',
      endpoint: 'https://fsn1.your-objectstorage.com',
    });
    await cs?.list('.pulumi/stacks/');
    const listed = ci.sent.find((s) => s.name === 'ListObjectsV2Command');
    expect(listed?.region).toBe('fsn1');
    expect((listed?.input as { Bucket: string } | undefined)?.Bucket).toBe('vc-e2e-state-ci-xyz');
  });

  it('falls back to the derived name, per namespace, without an override', async () => {
    const f = fakeS3('nowhere');
    const s = e2eStateStore('hetzner', HETZNER_ENV, { namespace: 'ci', s3: f.s3 });
    expect((await s?.where()) === null).toBe(true);
    const sent = f.sent.filter((x) => x.name === 'HeadBucketCommand');
    expect(sent.length).toBeGreaterThan(0);
    for (const x of sent) expect((x.input as { Bucket: string }).Bucket).toBe('vc-e2e-state-ci');
  });

  it('returns null without storage credentials', () => {
    expect(e2eStateStore('hetzner', {})).toBeNull();
    expect(e2eStateStore('hetzner', { HETZNER_ACCESS_KEY: 'a' })).toBeNull();
    expect(e2eStateStore('digitalocean', HETZNER_ENV)).toBeNull();
  });

  it('dry run deletes nothing', async () => {
    const f = fakeS3('nbg1');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = e2eStateStore('hetzner', HETZNER_ENV, { dryRun: true, s3: f.s3 });
    expect(await s?.remove(['a', 'b'])).toEqual([]);
    expect(log).toHaveBeenCalledWith('would delete a');
    expect(log).toHaveBeenCalledWith('would delete b');
    expect(f.sent.some((x) => x.name === 'DeleteObjectCommand')).toBe(false);
    log.mockRestore();
  });

  it('a delete 404 counts as gone, other errors do not', async () => {
    const s3 = () => ({
      send: async (cmd: { constructor: { name: string }; input: { Key?: string } }) => {
        if (cmd.constructor.name === 'HeadBucketCommand') return {};
        if (cmd.input.Key === 'missing') throw notFound();
        if (cmd.input.Key === 'denied')
          throw Object.assign(new Error('no'), { $metadata: { httpStatusCode: 403 } });
        return {};
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = e2eStateStore('hetzner', HETZNER_ENV, { s3 });
    expect(await s?.remove(['ok', 'missing', 'denied'])).toEqual(['ok', 'missing']);
  });

  it('an unlocatable bucket reads as an incomplete listing', async () => {
    const s3 = () => ({
      send: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'Error' });
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = e2eStateStore('hetzner', HETZNER_ENV, { s3 });
    expect(await s?.list('.pulumi/stacks/')).toEqual({ keys: [], complete: false });
  });
});

describe('ownsStaleScratchProject', () => {
  const now = 1_800_000_000_000;
  const proj = (ageMs: number, prefix = 'citest') => `${prefix}-compose-${now - ageMs}-abc123`;
  const env = { E2E_NAMESPACE: 'ci' } as NodeJS.ProcessEnv;
  const owns = ownsStaleScratchProject(now, env);

  it('does not own a 2-hour-old project, owns a 13-hour-old one', () => {
    expect(owns(proj(2 * 3_600_000))).toBe(false);
    expect(owns(proj(13 * 3_600_000))).toBe(true);
  });
  it('does not own a name that does not parse, or another namespace', () => {
    expect(owns('citest-compose-notatime-abc123')).toBe(false);
    expect(owns('citest-whatever')).toBe(false);
    expect(owns(proj(13 * 3_600_000, 'testapp'))).toBe(false);
    expect(owns(`${proj(13 * 3_600_000)}x`)).toBe(false);
  });
});
