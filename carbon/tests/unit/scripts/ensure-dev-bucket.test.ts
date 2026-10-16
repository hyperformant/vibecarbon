import { HeadBucketCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_FAILURE_HELP,
  devOrigins,
  ensureDevBucket,
  prepareDevBucket,
} from '../../../scripts/ensure-dev-bucket';

function fakeClient(handlers: Record<string, (cmd: unknown) => unknown> = {}) {
  const sent: unknown[] = [];
  const send = vi.fn(async (cmd: { constructor: { name: string } }) => {
    sent.push(cmd);
    const h = handlers[cmd.constructor.name];
    return h ? h(cmd) : {};
  });
  return { client: { send }, sent };
}

const names = (sent: unknown[]) => sent.map((c) => (c as object).constructor.name);
const notFound = () => {
  throw Object.assign(new Error('nf'), { name: 'NotFound' });
};

describe('ensureDevBucket', () => {
  it('puts CORS on the bucket the S3 service created', async () => {
    const { client, sent } = fakeClient();
    await ensureDevBucket({ client, bucket: 'demo-local', origins: ['http://localhost:5173'] });
    expect(names(sent)).toEqual([HeadBucketCommand.name, PutBucketCorsCommand.name]);
  });

  // Garage creates the bucket itself (--default-bucket). One made through the
  // S3 API would get a key-local alias, whose CORS Garage ignores on
  // preflights, so a missing bucket is an error main() retries, never a create.
  it('never creates a missing bucket: it throws so main() retries', async () => {
    const { client, sent } = fakeClient({ HeadBucketCommand: notFound });
    await expect(
      ensureDevBucket({ client, bucket: 'demo-local', origins: ['http://localhost:5173'] }),
    ).rejects.toThrow('nf');
    expect(names(sent)).toEqual([HeadBucketCommand.name]);
  });

  it('puts the CORS rule deploy sets on real buckets, for the dev origins', async () => {
    const { client, sent } = fakeClient();
    const origins = ['http://localhost:5173', 'http://localhost:5183'];
    await ensureDevBucket({ client, bucket: 'b', origins });
    const cors = sent.find((c) => c instanceof PutBucketCorsCommand) as PutBucketCorsCommand;
    const rule = cors.input.CORSConfiguration?.CORSRules?.[0];
    expect(cors.input.Bucket).toBe('b');
    expect(rule).toEqual({
      AllowedOrigins: origins,
      AllowedMethods: ['GET', 'PUT', 'HEAD'],
      AllowedHeaders: ['content-type', 'content-length'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3600,
    });
  });
});

describe('devOrigins', () => {
  // Same port rule as scripts/dev.js and the server CORS: DEV_VITE_PORT wins,
  // else 5173 + DEV_PORT_OFFSET.
  it('defaults to the Vite port 5173', () => {
    expect(devOrigins({})).toEqual(['http://localhost:5173']);
  });

  it('shifts the Vite port by DEV_PORT_OFFSET', () => {
    expect(devOrigins({ DEV_PORT_OFFSET: '10' })).toEqual(['http://localhost:5183']);
  });

  it('lets DEV_VITE_PORT win over DEV_PORT_OFFSET', () => {
    expect(devOrigins({ DEV_VITE_PORT: '6000', DEV_PORT_OFFSET: '10' })).toEqual([
      'http://localhost:6000',
    ]);
  });

  it('treats an unparseable offset as 0', () => {
    expect(devOrigins({ DEV_PORT_OFFSET: 'abc' })).toEqual(['http://localhost:5173']);
  });
});

describe('prepareDevBucket', () => {
  const origins = ['http://localhost:5173'];
  const fail = (props: Record<string, unknown>) => () => {
    throw Object.assign(new Error(String(props.name ?? props.code ?? 'err')), props);
  };
  // Fails with `error` for the first `times` HeadBuckets, then succeeds.
  const flaky = (error: () => never, times: number) => {
    let n = 0;
    return () => {
      n++;
      if (n <= times) error();
      return {};
    };
  };
  const run = (client: { send: unknown }) => {
    const sleep = vi.fn(async () => {});
    const done = prepareDevBucket({ client, bucket: 'b', origins, attempts: 5, sleep });
    return { done, sleep };
  };

  it('waits out Garage starting: refused connections, then a not-yet-created bucket', async () => {
    let n = 0;
    const { client, sent } = fakeClient({
      HeadBucketCommand: () => {
        n++;
        if (n === 1) fail({ code: 'ECONNREFUSED' })();
        if (n === 2) notFound();
        return {};
      },
    });
    const { done, sleep } = run(client);
    await expect(done).resolves.toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(names(sent).at(-1)).toBe(PutBucketCorsCommand.name);
  });

  it('gives up with the last error once the attempts run out', async () => {
    const { client } = fakeClient({ HeadBucketCommand: notFound });
    const { done, sleep } = run(client);
    await expect(done).rejects.toThrow('nf');
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['a 403 status', { name: 'Forbidden', $metadata: { httpStatusCode: 403 } }],
    ['InvalidAccessKeyId', { name: 'InvalidAccessKeyId', $metadata: { httpStatusCode: 403 } }],
    ['SignatureDoesNotMatch', { name: 'SignatureDoesNotMatch' }],
  ])('stops at once on %s and says how to fix the key', async (_label, props) => {
    const { client, sent } = fakeClient({ HeadBucketCommand: flaky(fail(props), 99) });
    const { done, sleep } = run(client);
    await expect(done).rejects.toThrow(AUTH_FAILURE_HELP);
    expect(sleep).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it('names the fix: dev-init --force or a fresh create', () => {
    expect(AUTH_FAILURE_HELP).toContain("doesn't match the local Garage");
    expect(AUTH_FAILURE_HELP).toContain('node scripts/dev-init.js --force');
    expect(AUTH_FAILURE_HELP).toContain('S3_ACCESS_KEY and S3_SECRET_KEY');
  });

  it('does not retry any other error', async () => {
    const { client, sent } = fakeClient({
      HeadBucketCommand: fail({ name: 'InternalError', $metadata: { httpStatusCode: 500 } }),
    });
    const { done, sleep } = run(client);
    await expect(done).rejects.toThrow('InternalError');
    expect(sleep).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });
});
