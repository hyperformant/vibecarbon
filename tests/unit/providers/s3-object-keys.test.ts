/**
 * The three object calls the seal's history cleanup makes through a state
 * bucket's own client (lib/iac/state-history.js): list every key under a
 * prefix, read one object, delete exactly the keys it names. Each goes
 * through `_send`, the provider's retrying sender.
 */
import { describe, expect, it, vi } from 'vitest';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';

type Sent = { constructor: { name: string }; input: Record<string, unknown> };
type Calls = {
  _send: (c: Sent) => Promise<unknown>;
  listObjectKeys: (b: string, prefix: string) => Promise<string[]>;
  getObjectBytes: (b: string, key: string) => Promise<Buffer>;
  deleteObjectKeys: (b: string, keys: string[]) => Promise<void>;
};

function provider(answer: (c: Sent) => unknown) {
  const p = new HetznerS3Provider('ak', 'sk', 'fsn1') as unknown as Calls;
  const send = vi.fn(async (c: Sent) => answer(c));
  p._send = send;
  return { p, send };
}

describe('S3CompatibleProvider object keys', () => {
  it('listObjectKeys follows continuation tokens and keeps the prefix', async () => {
    const pages = [['h/a', 'h/b'], ['h/c']];
    let page = 0;
    const { p, send } = provider(() => {
      const keys = pages[page++] ?? [];
      const more = page < pages.length;
      return {
        Contents: keys.map((Key) => ({ Key })),
        IsTruncated: more,
        NextContinuationToken: more ? 't1' : undefined,
      };
    });
    expect(await p.listObjectKeys('state-b', 'h/')).toEqual(['h/a', 'h/b', 'h/c']);
    expect(send.mock.calls.map((c) => c[0].input)).toEqual([
      { Bucket: 'state-b', Prefix: 'h/', ContinuationToken: undefined },
      { Bucket: 'state-b', Prefix: 'h/', ContinuationToken: 't1' },
    ]);
  });

  it('getObjectBytes reads the one object', async () => {
    const { p, send } = provider(() => ({
      Body: { transformToByteArray: async () => new TextEncoder().encode('{"a":1}') },
    }));
    expect((await p.getObjectBytes('state-b', 'h/a')).toString('utf8')).toBe('{"a":1}');
    expect(send.mock.calls[0][0].constructor.name).toBe('GetObjectCommand');
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: 'state-b', Key: 'h/a' });
  });

  it('deleteObjectKeys deletes exactly the keys, in batches of 1000', async () => {
    const { p, send } = provider(() => ({}));
    const keys = Array.from({ length: 1500 }, (_, i) => `h/${i}`);
    await p.deleteObjectKeys('state-b', keys);
    const batches = send.mock.calls.map(
      (c) => (c[0].input.Delete as { Objects: Array<{ Key: string }> }).Objects,
    );
    expect(send.mock.calls.every((c) => c[0].constructor.name === 'DeleteObjectsCommand')).toBe(
      true,
    );
    expect(batches.map((b) => b.length)).toEqual([1000, 500]);
    expect(batches.flat().map((o) => o.Key)).toEqual(keys);
  });

  it('a key the store reports in Errors fails the delete, rather than counting as gone', async () => {
    const { p } = provider(() => ({ Errors: [{ Key: 'h/a', Code: 'AccessDenied' }] }));
    await expect(p.deleteObjectKeys('state-b', ['h/a'])).rejects.toThrow(
      '1 object(s) in state-b were not deleted (first: h/a: AccessDenied)',
    );
  });

  it('no keys: no request', async () => {
    const { p, send } = provider(() => ({}));
    await p.deleteObjectKeys('state-b', []);
    expect(send).not.toHaveBeenCalled();
  });
});
