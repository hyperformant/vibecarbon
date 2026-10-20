/**
 * Environments share one app bucket, so they share its CORS rule. Deploy
 * merges this environment's origin into what the bucket already allows,
 * destroy removes only its own, and neither may drop another env's origin.
 * The merge runs beside the IaC step (R7) and is awaited before the outro.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  applyAppBucketCors,
  mergeCorsOrigins,
  removeAppBucketCorsOrigins,
  startAppBucketFinalize,
} from '../../../src/lib/deploy/orchestrator.js';

const spin = () => ({ start: vi.fn(), stop: vi.fn() });

describe('mergeCorsOrigins', () => {
  it('adds a new origin, deduped and sorted', () => {
    expect(mergeCorsOrigins(['https://b.dev'], ['https://a.dev'])).toEqual([
      'https://a.dev',
      'https://b.dev',
    ]);
    expect(mergeCorsOrigins(['https://a.dev'], ['https://b.dev'])).toEqual([
      'https://a.dev',
      'https://b.dev',
    ]);
  });

  it('re-adding an existing origin is a no-op', () => {
    expect(mergeCorsOrigins(['https://a.dev', 'https://b.dev'], ['https://a.dev'])).toEqual([
      'https://a.dev',
      'https://b.dev',
    ]);
  });

  it('remove drops only the named origins', () => {
    expect(
      mergeCorsOrigins(['https://a.dev', 'https://b.dev', 'https://c.dev'], [], ['https://b.dev']),
    ).toEqual(['https://a.dev', 'https://c.dev']);
  });

  it('keeps a domainless env localhost origins beside a domain env origin', () => {
    expect(
      mergeCorsOrigins(['http://localhost:3000', 'http://localhost:5173'], ['https://e1.dev']),
    ).toEqual(['http://localhost:3000', 'http://localhost:5173', 'https://e1.dev']);
  });
});

describe('removeAppBucketCorsOrigins', () => {
  it('deletes the rule when no origin is left, never PUTs an empty list', async () => {
    const provider = {
      getBucketCorsOrigins: vi.fn(async () => ['https://e1.dev']),
      setBucketCors: vi.fn(async () => {}),
      deleteBucketCors: vi.fn(async () => {}),
    };
    await removeAppBucketCorsOrigins({ provider, bucket: 'app-b', origins: ['https://e1.dev'] });
    expect(provider.deleteBucketCors).toHaveBeenCalledWith('app-b');
    expect(provider.setBucketCors).not.toHaveBeenCalled();
  });

  it('writes back the other environments origins', async () => {
    const provider = {
      getBucketCorsOrigins: vi.fn(async () => ['https://e1.dev', 'https://prod.dev']),
      setBucketCors: vi.fn(async () => {}),
      deleteBucketCors: vi.fn(async () => {}),
    };
    await removeAppBucketCorsOrigins({ provider, bucket: 'app-b', origins: ['https://e1.dev'] });
    expect(provider.setBucketCors).toHaveBeenCalledWith('app-b', ['https://prod.dev']);
    expect(provider.deleteBucketCors).not.toHaveBeenCalled();
  });

  it('touches nothing when the origins were never on the rule', async () => {
    const provider = {
      getBucketCorsOrigins: vi.fn(async () => ['https://prod.dev']),
      setBucketCors: vi.fn(async () => {}),
      deleteBucketCors: vi.fn(async () => {}),
    };
    await removeAppBucketCorsOrigins({ provider, bucket: 'app-b', origins: ['https://e1.dev'] });
    expect(provider.setBucketCors).not.toHaveBeenCalled();
    expect(provider.deleteBucketCors).not.toHaveBeenCalled();
  });
});

describe('applyAppBucketCors merge', () => {
  it('writes the existing origins plus this environment origin', async () => {
    const setBucketCors = vi.fn(async () => {});
    await applyAppBucketCors({
      createProvider: async () => ({
        getBucketCorsOrigins: async () => ['https://prod.dev'],
        setBucketCors,
      }),
      bucket: 'app-b',
      domain: 'staging.dev',
      spin: spin(),
      log: { warn: vi.fn() },
    });
    expect(setBucketCors).toHaveBeenCalledWith('app-b', [
      'https://prod.dev',
      'https://staging.dev',
    ]);
  });

  it('warns and does not PUT when the existing rule cannot be read', async () => {
    const setBucketCors = vi.fn(async () => {});
    const warn = vi.fn();
    await expect(
      applyAppBucketCors({
        createProvider: async () => ({
          getBucketCorsOrigins: async () => {
            throw new Error('Access Denied');
          },
          setBucketCors,
        }),
        bucket: 'app-b',
        domain: 'staging.dev',
        spin: spin(),
        log: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(setBucketCors).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('bucket');
    expect(warn.mock.calls[0][0]).toContain('Access Denied');
  });

  it('one GET and zero PUTs when the rule already allows this environment', async () => {
    const getBucketCorsOrigins = vi.fn(async () => ['https://staging.dev', 'https://prod.dev']);
    const setBucketCors = vi.fn(async () => {});
    await applyAppBucketCors({
      createProvider: async () => ({ getBucketCorsOrigins, setBucketCors }),
      bucket: 'app-b',
      domain: 'staging.dev',
      spin: spin(),
      log: { warn: vi.fn() },
    });
    expect(getBucketCorsOrigins).toHaveBeenCalledOnce();
    expect(setBucketCors).not.toHaveBeenCalled();
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
    expect(setBucketCors).toHaveBeenCalledWith('app-b', [
      'https://prod.dev',
      'https://staging.dev',
    ]);
  });

  it('holds warnings until finish so they never interleave with IaC output', async () => {
    const finalize = startAppBucketFinalize({
      createProvider: async () => ({
        getBucketCorsOrigins: async () => {
          throw new Error('Access Denied');
        },
        setBucketCors: vi.fn(),
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
});
