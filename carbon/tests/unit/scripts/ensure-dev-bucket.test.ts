import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { devOrigins, ensureDevBucket } from '../../../scripts/ensure-dev-bucket';

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
  it('creates the bucket when missing, then sets CORS', async () => {
    const { client, sent } = fakeClient({ HeadBucketCommand: notFound });
    await ensureDevBucket({ client, bucket: 'demo-local', origins: ['http://localhost:5173'] });
    expect(names(sent)).toEqual([
      HeadBucketCommand.name,
      CreateBucketCommand.name,
      PutBucketCorsCommand.name,
    ]);
  });

  it('tolerates BucketAlreadyOwnedByYou from create', async () => {
    const { client, sent } = fakeClient({
      HeadBucketCommand: notFound,
      CreateBucketCommand: () => {
        throw Object.assign(new Error('mine'), { name: 'BucketAlreadyOwnedByYou' });
      },
    });
    await expect(
      ensureDevBucket({ client, bucket: 'demo-local', origins: ['http://localhost:5173'] })
    ).resolves.toBeUndefined();
    expect(names(sent).at(-1)).toBe(PutBucketCorsCommand.name);
  });

  it('skips create when the bucket exists but still puts CORS', async () => {
    const { client, sent } = fakeClient();
    await ensureDevBucket({ client, bucket: 'demo-local', origins: ['http://localhost:5173'] });
    expect(names(sent)).toEqual([HeadBucketCommand.name, PutBucketCorsCommand.name]);
  });

  it('rethrows unexpected create errors', async () => {
    const { client } = fakeClient({
      HeadBucketCommand: notFound,
      CreateBucketCommand: () => {
        throw Object.assign(new Error('boom'), { name: 'AccessDenied' });
      },
    });
    await expect(
      ensureDevBucket({ client, bucket: 'b', origins: ['http://localhost:5173'] })
    ).rejects.toThrow('boom');
  });

  it('allows GET/PUT/HEAD from the dev origins', async () => {
    const { client, sent } = fakeClient();
    const origins = ['http://localhost:5173', 'http://localhost:5183'];
    await ensureDevBucket({ client, bucket: 'b', origins });
    const cors = sent.find((c) => c instanceof PutBucketCorsCommand) as PutBucketCorsCommand;
    const rule = cors.input.CORSConfiguration?.CORSRules?.[0];
    expect(cors.input.Bucket).toBe('b');
    expect(rule?.AllowedOrigins).toEqual(origins);
    expect(rule?.AllowedMethods).toEqual(['GET', 'PUT', 'HEAD']);
    expect(rule?.AllowedHeaders).toEqual(['*']);
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
