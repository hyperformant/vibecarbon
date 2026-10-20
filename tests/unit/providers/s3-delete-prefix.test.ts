/**
 * Environments share one app bucket under `<env>/` key prefixes, so destroy
 * removes one environment's objects with deletePrefix instead of emptying
 * the bucket. A bad prefix would widen that to every environment's data, so
 * deletePrefix refuses anything that is not a `/`-terminated, non-root path.
 */
import { describe, expect, it, vi } from 'vitest';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';

type Sent = { constructor: { name: string }; input: Record<string, unknown> };

function provider(pages: string[][]) {
  const p = new HetznerS3Provider('ak', 'sk', 'fsn1') as unknown as {
    _send: (c: Sent) => Promise<unknown>;
    deletePrefix: (b: string, prefix: string) => Promise<{ objectsRemoved: number }>;
  };
  let page = 0;
  const send = vi.fn(async (c: Sent) => {
    if (c.constructor.name === 'ListObjectsV2Command') {
      const keys = pages[page] ?? [];
      page += 1;
      const more = page < pages.length;
      return {
        Contents: keys.map((Key) => ({ Key })),
        IsTruncated: more,
        NextContinuationToken: more ? `t${page}` : undefined,
      };
    }
    return {};
  });
  p._send = send;
  return { p, send };
}

const keys = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `staging/f${String(from + i)}`);

describe('S3CompatibleProvider#deletePrefix', () => {
  it.each(['', '/', 'prod', '//'])('refuses the prefix %j before any request', async (prefix) => {
    const { p, send } = provider([]);
    await expect(p.deletePrefix('app-b', prefix)).rejects.toThrow(/prefix/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('lists with the prefix and deletes only the listed keys', async () => {
    const { p, send } = provider([['staging/a', 'staging/b']]);
    const result = await p.deletePrefix('app-b', 'staging/');
    expect(result).toEqual({ objectsRemoved: 2 });
    const list = send.mock.calls[0][0];
    expect(list.constructor.name).toBe('ListObjectsV2Command');
    expect(list.input).toMatchObject({ Bucket: 'app-b', Prefix: 'staging/' });
    const del = send.mock.calls[1][0];
    expect(del.constructor.name).toBe('DeleteObjectsCommand');
    expect(del.input).toEqual({
      Bucket: 'app-b',
      Delete: { Objects: [{ Key: 'staging/a' }, { Key: 'staging/b' }] },
    });
  });

  it('a 2,500-object listing deletes in 3 batches, following continuation tokens', async () => {
    const { p, send } = provider([keys(1000), keys(1000, 1000), keys(500, 2000)]);
    const result = await p.deletePrefix('app-b', 'staging/');
    expect(result.objectsRemoved).toBe(2500);
    const lists = send.mock.calls.filter((c) => c[0].constructor.name === 'ListObjectsV2Command');
    expect(lists.map((c) => c[0].input.ContinuationToken)).toEqual([undefined, 't1', 't2']);
    for (const c of lists) expect(c[0].input.Prefix).toBe('staging/');
    const deletes = send.mock.calls.filter((c) => c[0].constructor.name === 'DeleteObjectsCommand');
    expect(deletes).toHaveLength(3);
    expect(
      deletes.map((c) => (c[0].input.Delete as { Objects: unknown[] }).Objects.length),
    ).toEqual([1000, 1000, 500]);
  });

  it('splits a page larger than 1000 keys into batches of 1000', async () => {
    const { p, send } = provider([keys(2500)]);
    const result = await p.deletePrefix('app-b', 'staging/');
    expect(result.objectsRemoved).toBe(2500);
    const deletes = send.mock.calls.filter((c) => c[0].constructor.name === 'DeleteObjectsCommand');
    expect(
      deletes.map((c) => (c[0].input.Delete as { Objects: unknown[] }).Objects.length),
    ).toEqual([1000, 1000, 500]);
  });

  it('fails loudly when DeleteObjects reports keys it could not delete', async () => {
    const { p, send } = provider([['staging/a', 'staging/b']]);
    send.mockImplementation(async (c: Sent) =>
      c.constructor.name === 'ListObjectsV2Command'
        ? { Contents: [{ Key: 'staging/a' }, { Key: 'staging/b' }], IsTruncated: false }
        : { Errors: [{ Key: 'staging/b', Code: 'AccessDenied' }] },
    );
    await expect(p.deletePrefix('app-b', 'staging/')).rejects.toThrow(/staging\/b: AccessDenied/);
  });

  it('an empty prefix listing sends no delete', async () => {
    const { p, send } = provider([[]]);
    expect(await p.deletePrefix('app-b', 'staging/')).toEqual({ objectsRemoved: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
