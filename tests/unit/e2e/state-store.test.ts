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

  describe('another namespace swaps the namespace segment', () => {
    const headBuckets = async (env: Record<string, string>, namespace: 'local' | 'ci') => {
      const f = fakeS3('nowhere');
      const s = e2eStateStore('hetzner', { ...HETZNER_ENV, ...env }, { namespace, s3: f.s3 });
      await s?.where();
      return [
        ...new Set(
          f.sent
            .filter((x) => x.name === 'HeadBucketCommand')
            .map((x) => (x.input as { Bucket: string }).Bucket),
        ),
      ];
    };
    it('local to ci', async () => {
      expect(await headBuckets({ VC_E2E_STATE_BUCKET: 'vc-e2e-state-local-6586f2' }, 'ci')).toEqual(
        ['vc-e2e-state-ci-6586f2'],
      );
    });
    it('ci to local', async () => {
      expect(
        await headBuckets(
          { E2E_NAMESPACE: 'ci', VC_E2E_STATE_BUCKET: 'vc-e2e-state-ci-6586f2' },
          'local',
        ),
      ).toEqual(['vc-e2e-state-local-6586f2']);
    });
    it('a name without a suffix', async () => {
      expect(await headBuckets({}, 'ci')).toEqual(['vc-e2e-state-ci']);
    });
    it('a custom override shape returns null and says why', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(
        e2eStateStore(
          'hetzner',
          { ...HETZNER_ENV, VC_E2E_STATE_BUCKET: 'my-own-state' },
          { namespace: 'ci' },
        ),
      ).toBeNull();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain('my-own-state');
      log.mockRestore();
    });
  });

  it('a bucket found nowhere lists as incomplete, never as empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = e2eStateStore('hetzner', HETZNER_ENV, { s3: fakeS3('nowhere').s3 });
    expect(await s?.list('.pulumi/stacks/')).toEqual({ keys: [], complete: false });
    expect(await s?.remove(['k'])).toEqual([]);
    warn.mockRestore();
  });

  it('a candidate region that could not be worked out carries its error into the warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { LinodeObjectStorageProvider } = await import(
      '../../../src/lib/providers/linode-objectstorage.js'
    );
    const spy = vi
      .spyOn(LinodeObjectStorageProvider, 'resolveAccountS3Region')
      .mockImplementation(async (region: string) => {
        if (region === 'us-iad') throw new Error('endpoint list refused');
        return 'us-ord-1';
      });
    const f = fakeS3('nowhere');
    const s = e2eStateStore(
      'linode',
      { LINODE_ACCESS_KEY: 'a', LINODE_SECRET_KEY: 's', LINODE_API_TOKEN: 't' },
      { s3: f.s3 },
    );
    expect(await s?.list('.pulumi/stacks/')).toEqual({ keys: [], complete: false });
    expect(warn.mock.calls.flat().join('\n')).toContain('endpoint list refused');
    spy.mockRestore();
    warn.mockRestore();
  });

  it('remove never rejects, even when the client cannot be built', async () => {
    let n = 0;
    const s3 = () => {
      if (++n > 1) throw new Error('client broke');
      return { send: async () => ({}) };
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = e2eStateStore('hetzner', HETZNER_ENV, { s3 });
    await expect(s?.remove(['a'])).resolves.toEqual([]);
  });

  it('a truncated page without a continuation token ends the listing incomplete', async () => {
    const s3 = () => ({
      send: async (cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'HeadBucketCommand'
          ? {}
          : { Contents: [{ Key: 'k1' }], IsTruncated: true },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = e2eStateStore('hetzner', HETZNER_ENV, { s3 });
    expect(await s?.list('.pulumi/stacks/')).toEqual({ keys: ['k1'], complete: false });
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
