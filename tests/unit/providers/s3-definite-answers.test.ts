/**
 * A definite S3 4xx answer is never retried as transient.
 *
 * S3-compatible stores send some 4xx with no message; the AWS SDK words those
 * `UnknownError`, and the wording regex in s3-base read that as a network
 * failure. A bare 404 ("this bucket has no policy") then cost `_send`'s default
 * 5 s + 10 s of retries. #360 fixed only the CORS read; the status rule fixes
 * the class. The census at the bottom keeps every `_send` call honest.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';
import { isTransientS3Error } from '../../../src/lib/providers/s3-base.js';

function s3Error(status: number, name = 'UnknownError', message = 'UnknownError') {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
}

describe('isTransientS3Error', () => {
  it.each([400, 401, 403, 404, 409, 412, 416, 499])(
    'a message-less %i is a definite answer, not transient',
    (status) => {
      expect(isTransientS3Error(s3Error(status))).toBe(false);
    },
  );

  it('a 4xx stays definite even when its message reads like a network fault', () => {
    expect(isTransientS3Error(s3Error(404, 'NoSuchKey', 'ECONNRESET 503'))).toBe(false);
  });

  it.each([408, 429, 500, 502, 503, 504])('%i is transient', (status) => {
    expect(isTransientS3Error(s3Error(status, 'Whatever', 'x'))).toBe(true);
  });

  it('network errors with no status are transient', () => {
    expect(isTransientS3Error(Object.assign(new Error('read ECONNRESET'), { code: 'x' }))).toBe(
      true,
    );
    expect(isTransientS3Error(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTransientS3Error(new Error('UnknownError'))).toBe(true);
  });

  it('a plain error with nothing transient in it is not', () => {
    expect(isTransientS3Error(new Error('boom'))).toBe(false);
    expect(isTransientS3Error(null)).toBe(false);
  });
});

describe('bare answers return at once', () => {
  afterEach(() => vi.useRealTimers());

  function provider(send: () => Promise<unknown>) {
    const p = new HetznerS3Provider('ak', 'sk', 'fsn1') as unknown as {
      getClient: () => { send: () => Promise<unknown> };
      getBucketPolicy: (b: string) => Promise<unknown>;
      deleteBucketPolicy: (b: string) => Promise<void>;
    };
    p.getClient = () => ({ send });
    return p;
  }

  it('getBucketPolicy on a message-less 404 is null, in under 1 s, after one request', async () => {
    const send = vi.fn(async () => {
      throw s3Error(404);
    });
    const p = provider(send);
    const started = Date.now();
    await expect(p.getBucketPolicy('b')).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(send).toHaveBeenCalledOnce();
  });

  it('deleteBucketPolicy on a message-less 403 throws after one request', async () => {
    const send = vi.fn(async () => {
      throw s3Error(403);
    });
    const p = provider(send);
    await expect(p.deleteBucketPolicy('b')).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('setBucketCors on a brand new bucket', () => {
  afterEach(() => vi.useRealTimers());

  function provider(send: () => Promise<unknown>) {
    const p = new HetznerS3Provider('ak', 'sk', 'fsn1') as unknown as {
      getClient: () => { send: () => Promise<unknown> };
      setBucketCors: (b: string, o: string[], opts?: { untilVisibleMs?: number }) => Promise<void>;
    };
    p.getClient = () => ({ send });
    return p;
  }

  it('fails on the first 404 by default', async () => {
    const send = vi.fn(async () => {
      throw s3Error(404);
    });
    await expect(provider(send).setBucketCors('b', ['https://a.dev'])).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });

  it('with untilVisibleMs it waits one second at a time for the bucket, then writes', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockRejectedValueOnce(s3Error(404))
      .mockRejectedValueOnce(s3Error(404))
      .mockResolvedValueOnce({});
    const done = provider(send).setBucketCors('b', ['https://a.dev'], { untilVisibleMs: 15_000 });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('gives up when the budget is spent, and never waits on a 403', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => {
      throw s3Error(404);
    });
    const done = provider(send).setBucketCors('b', ['https://a.dev'], { untilVisibleMs: 3000 });
    const assertion = expect(done).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(send.mock.calls.length).toBeLessThanOrEqual(4);

    const denied = vi.fn(async () => {
      throw s3Error(403);
    });
    await expect(
      provider(denied).setBucketCors('b', ['https://a.dev'], { untilVisibleMs: 15_000 }),
    ).rejects.toThrow();
    expect(denied).toHaveBeenCalledOnce();
  });
});

describe('census: every _send call site', () => {
  // Each `this._send(` call in s3-base is either one attempt (maxAttempts: 1),
  // names its own `terminal`, or relies on the status rule in
  // isTransientS3Error. Counting them here makes a new call site a decision.
  const source = readFileSync('src/lib/providers/s3-base.js', 'utf8');
  const calls: string[] = [];
  for (const m of source.matchAll(/this\._send\(/g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    while (depth > 0 && i < source.length) {
      if (source[i] === '(') depth++;
      if (source[i] === ')') depth--;
      i++;
    }
    calls.push(source.slice(start, i - 1));
  }

  it('finds the call sites', () => {
    expect(calls.length).toBeGreaterThan(20);
  });

  it('none of them waits on a message-less 4xx: the classifier checks status first', () => {
    const rules = source.match(/function isTransientS3Error[\s\S]*?\n}\n/)?.[0] ?? '';
    const statusAt = rules.indexOf('isDefiniteClientError(');
    const regexAt = rules.indexOf('TRANSIENT_S3_ERROR_RE.test');
    expect(statusAt).toBeGreaterThan(-1);
    expect(statusAt).toBeLessThan(regexAt);
  });

  it('call sites on the default retry are exactly the ones that rely on the status rule', () => {
    const defaults = calls.filter((c) => !/maxAttempts: 1|terminal/.test(c));
    // Reviewed 2026-11-11: list/delete/copy/policy/cors writes. Each is a
    // definite answer on 4xx and retried only on 408/429/5xx/network.
    // Reviewed 2026-11-12: the state history cleanup's list, read and batch
    // delete (listObjectKeys, getObjectBytes, deleteObjectKeys; lib/iac/
    // state-history.js). A 4xx there fails the cleanup at once, which warns
    // and leaves the seal marker unset, so the next deploy tries again.
    expect(defaults.length).toBe(19);
  });
});
