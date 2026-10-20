/**
 * Each environment has its own app bucket, so its CORS rule has one owner:
 * deploy PUTs exactly this environment's origins, and skips the PUT when the
 * rule already equals them. The work runs beside the IaC step (R7) and is
 * awaited before the outro.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  applyAppBucketCors,
  startAppBucketFinalize,
} from '../../../src/lib/deploy/orchestrator.js';

const LOCALHOST = ['http://localhost:3000', 'http://localhost:5173'];

describe('applyAppBucketCors', () => {
  it('a domainless env redeployed with a domain PUTs exactly https://<domain> (Review Focus 5)', async () => {
    const setBucketCors = vi.fn(async () => {});
    await applyAppBucketCors({
      createProvider: async () => ({ getBucketCorsOrigins: async () => LOCALHOST, setBucketCors }),
      bucket: 'app-b',
      domain: 'e1.dev',
      log: { warn: vi.fn() },
    });
    expect(setBucketCors).toHaveBeenCalledOnce();
    expect(setBucketCors).toHaveBeenCalledWith('app-b', ['https://e1.dev']);
  });

  it('one GET and zero PUTs when the rule already equals this environment set', async () => {
    const getBucketCorsOrigins = vi.fn(async () => ['https://staging.dev']);
    const setBucketCors = vi.fn(async () => {});
    await applyAppBucketCors({
      createProvider: async () => ({ getBucketCorsOrigins, setBucketCors }),
      bucket: 'app-b',
      domain: 'staging.dev',
      log: { warn: vi.fn() },
    });
    expect(getBucketCorsOrigins).toHaveBeenCalledOnce();
    expect(setBucketCors).not.toHaveBeenCalled();
  });

  it('zero PUTs for a domainless env whose rule holds the localhost pair in any order', async () => {
    const setBucketCors = vi.fn(async () => {});
    await applyAppBucketCors({
      createProvider: async () => ({
        getBucketCorsOrigins: async () => [...LOCALHOST].reverse(),
        setBucketCors,
      }),
      bucket: 'app-b',
      log: { warn: vi.fn() },
    });
    expect(setBucketCors).not.toHaveBeenCalled();
  });

  it('a rule holding extra origins is replaced by exactly this environment set', async () => {
    const setBucketCors = vi.fn(async () => {});
    await applyAppBucketCors({
      createProvider: async () => ({
        getBucketCorsOrigins: async () => ['https://staging.dev', 'https://old.dev'],
        setBucketCors,
      }),
      bucket: 'app-b',
      domain: 'staging.dev',
      log: { warn: vi.fn() },
    });
    expect(setBucketCors).toHaveBeenCalledWith('app-b', ['https://staging.dev']);
  });

  it('a GET that throws still PUTs this environment set, with no warning', async () => {
    const setBucketCors = vi.fn(async () => {});
    const warn = vi.fn();
    await applyAppBucketCors({
      createProvider: async () => ({
        getBucketCorsOrigins: async () => {
          throw new Error('Access Denied');
        },
        setBucketCors,
      }),
      bucket: 'app-b',
      domain: 'staging.dev',
      log: { warn },
    });
    expect(setBucketCors).toHaveBeenCalledWith('app-b', ['https://staging.dev']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failed PUT warns with the cause instead of throwing', async () => {
    const warn = vi.fn();
    await expect(
      applyAppBucketCors({
        createProvider: async () => ({
          getBucketCorsOrigins: async () => [],
          setBucketCors: async () => {
            throw new Error('Access Denied');
          },
        }),
        bucket: 'app-b',
        domain: 'staging.dev',
        log: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('Access Denied');
    expect(warn.mock.calls[0][0]).toContain('app-b');
  });
});

describe('startAppBucketFinalize (R7: beside IaC, awaited before the outro)', () => {
  it('returns before the CORS read settles, and finish waits for it', async () => {
    const events: string[] = [];
    let releaseRead: (o: string[]) => void = () => {};
    const readGate = new Promise<string[]>((r) => {
      releaseRead = r;
    });
    const setBucketCors = vi.fn(async () => {
      events.push('cors-put');
    });
    const finalize = startAppBucketFinalize({
      providerId: 'digitalocean',
      createProvider: async () => ({
        getBucketCorsOrigins: () => readGate,
        setBucketCors,
      }),
      bucket: 'app-b',
      domain: 'staging.dev',
    });

    // The fake IaC step starts while the CORS read is still pending.
    events.push('iac-start');
    let finished = false;
    const outro = finalize.finish({ warn: vi.fn() }).then(() => {
      finished = true;
      events.push('outro');
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(setBucketCors).not.toHaveBeenCalled();
    expect(finished).toBe(false);

    releaseRead(['https://prod.dev']);
    await outro;
    expect(events).toEqual(['iac-start', 'cors-put', 'outro']);
    expect(setBucketCors).toHaveBeenCalledWith('app-b', ['https://staging.dev']);
  });

  it('builds one S3 client for the CORS check and the creation-time read', async () => {
    const createProvider = vi.fn(async () => ({
      getBucketCorsOrigins: async () => ['https://prod.dev'],
      setBucketCors: vi.fn(),
      bucketCreatedAt: async () => new Date(Date.now() - 60 * 60_000),
    }));
    const finalize = startAppBucketFinalize({
      providerId: 'hetzner',
      createProvider,
      bucket: 'app-b',
      domain: 'prod.dev',
    });
    const result = await finalize.finish({ warn: vi.fn(), info: vi.fn() });
    expect(result.bucketCreatedAt).toEqual(expect.any(String));
    expect(createProvider).toHaveBeenCalledOnce();
  });

  it('holds warnings until finish so they never interleave with IaC output', async () => {
    const finalize = startAppBucketFinalize({
      providerId: 'digitalocean',
      createProvider: async () => ({
        getBucketCorsOrigins: async () => [],
        setBucketCors: async () => {
          throw new Error('Access Denied');
        },
      }),
      bucket: 'app-b',
      domain: 'staging.dev',
    });
    await new Promise((r) => setTimeout(r, 10));
    const warn = vi.fn();
    await finalize.finish({ warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('Access Denied');
  });

  it('finish on a 0-window provider resolves to an empty result', async () => {
    const finalize = startAppBucketFinalize({
      providerId: 'digitalocean',
      createProvider: async () => ({
        getBucketCorsOrigins: async () => [],
        setBucketCors: vi.fn(async () => {}),
      }),
      bucket: 'app-b',
      domain: 'staging.dev',
    });
    await expect(finalize.finish({ warn: vi.fn(), info: vi.fn() })).resolves.toEqual({});
  });
});

describe('orchestrator call site', () => {
  const src = readFileSync(
    join(import.meta.dirname, '../../../src/lib/deploy/orchestrator.js'),
    'utf-8',
  );

  it('starts the finalize after s3-setup without awaiting it, before any IaC dispatch', () => {
    // `= startAppBucketFinalize({` cannot match `= await startAppBucketFinalize({`.
    const starts = [...src.matchAll(/= startAppBucketFinalize\(\{/g)];
    expect(starts).toHaveLength(1);
    const at = starts[0].index as number;
    expect(at).toBeGreaterThan(src.indexOf("state.getStepResult('s3-setup')"));
    expect(at).toBeLessThan(src.indexOf('await runPlan('));
    expect(src).not.toMatch(/await applyAppBucketCors\(/);
  });

  it('awaits the finalize after the tier deploy and before the success outro', () => {
    const finish = src.indexOf('await appBucketFinalize.finish(');
    expect(finish).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(src.lastIndexOf("perfAsync('deploy.ha.k8s.full'"));
    expect(finish).toBeLessThan(src.indexOf('complete! ${c.dim('));
  });

  it('persists neither keyPrefix nor corsOrigins in the env s3 block', () => {
    expect(src.match(/keyPrefix|corsOrigins/g) ?? []).toEqual([]);
  });
});
