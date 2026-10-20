/**
 * `settleWindowFor` throws when a provider's S3 class declares no
 * `bucketSettleWindowMs` (a bug the census catches). Neither caller may let
 * that throw cost more than the settle row itself:
 *   - deploy's finalize runs after IaC succeeded; a rethrow there skipped the
 *     final config save, losing the record of what was just provisioned;
 *   - status would drop the whole environment's checks for one advisory row.
 * Both warn and treat the window as absent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/deploy/bucket-settle.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    settleWindowFor: async () => {
      throw new Error('FakeS3 does not declare static bucketSettleWindowMs');
    },
  };
});

const { startAppBucketFinalize } = await import('../../../src/lib/deploy/orchestrator.js');
const { storageSettleLine } = await import('../../../src/status.js');

afterEach(() => vi.restoreAllMocks());

describe('an undeclared settle window', () => {
  it('deploy finish warns, resolves the CORS origins, and records no bucketCreatedAt', async () => {
    const bucketCreatedAt = vi.fn();
    const finalize = startAppBucketFinalize({
      providerId: 'hetzner',
      createProvider: async () => ({
        getBucketCorsOrigins: async () => ['https://prod.dev'],
        setBucketCors: vi.fn(),
        bucketCreatedAt,
      }),
      bucket: 'app-b',
      domain: 'prod.dev',
    });
    const warn = vi.fn();
    const info = vi.fn();
    const result = await finalize.finish({ warn, info });
    expect(result).toEqual({ corsOrigins: ['https://prod.dev'] });
    expect(bucketCreatedAt).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('does not declare static bucketSettleWindowMs');
  });

  it('status warns and shows no row instead of failing the environment', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      storageSettleLine({ provider: 'hetzner', s3: { bucket: 'b', bucketCreatedAt: null } }),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('bucketSettleWindowMs');
  });
});
