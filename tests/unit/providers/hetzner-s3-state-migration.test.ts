import { describe, expect, it, vi } from 'vitest';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';

// Finding 1 (migration): the deploy-time copy of legacy Pulumi state from the
// app storage bucket into the dedicated state bucket. We mock the AWS SDK and
// tag each command class so the fake `send` can dispatch on command type.

vi.mock('@aws-sdk/client-s3', () => {
  const cmd = (type: string) =>
    class {
      __type = type;
      input: Record<string, unknown>;
      constructor(input: Record<string, unknown> = {}) {
        this.input = input;
      }
    };
  return {
    S3Client: class {
      send = vi.fn();
    },
    CopyObjectCommand: cmd('CopyObject'),
    CreateBucketCommand: cmd('CreateBucket'),
    DeleteBucketCommand: cmd('DeleteBucket'),
    DeleteObjectsCommand: cmd('DeleteObjects'),
    HeadBucketCommand: cmd('HeadBucket'),
    ListBucketsCommand: cmd('ListBuckets'),
    ListMultipartUploadsCommand: cmd('ListMultipartUploads'),
    ListObjectsV2Command: cmd('ListObjectsV2'),
    ListObjectVersionsCommand: cmd('ListObjectVersions'),
    AbortMultipartUploadCommand: cmd('AbortMultipart'),
    PutBucketCorsCommand: cmd('PutBucketCors'),
  };
});

function providerWithSend(handler: (type: string, input: Record<string, unknown>) => unknown) {
  const provider = new HetznerS3Provider('ak', 'sk', 'fsn1');
  const client = provider.getClient();
  // @ts-expect-error mocked send
  client.send = vi.fn((command: { __type: string; input: Record<string, unknown> }) =>
    Promise.resolve(handler(command.__type, command.input)),
  );
  // @ts-expect-error expose for assertions
  provider.__send = client.send;
  return provider;
}

describe('hasObjectsWithPrefix', () => {
  it('returns true when at least one object exists under the prefix', async () => {
    const provider = providerWithSend((type) =>
      type === 'ListObjectsV2' ? { KeyCount: 1, Contents: [{ Key: '.pulumi/meta.yaml' }] } : {},
    );
    expect(await provider.hasObjectsWithPrefix('bkt', '.pulumi/')).toBe(true);
  });

  it('returns false when the prefix is empty', async () => {
    const provider = providerWithSend((type) =>
      type === 'ListObjectsV2' ? { KeyCount: 0, Contents: [] } : {},
    );
    expect(await provider.hasObjectsWithPrefix('bkt', '.pulumi/')).toBe(false);
  });

  it('returns false (not throw) when the bucket does not exist', async () => {
    const provider = providerWithSend(() => {
      const err = new Error('no such bucket');
      // @ts-expect-error test shape
      err.name = 'NoSuchBucket';
      throw err;
    });
    expect(await provider.hasObjectsWithPrefix('missing', '.pulumi/')).toBe(false);
  });
});

describe('copyPrefix', () => {
  it('server-side copies every object under the prefix, preserving keys', async () => {
    const keys = ['.pulumi/meta.yaml', '.pulumi/stacks/vibecarbon/prod.json'];
    const copies: Array<{ Bucket: string; Key: string; CopySource: string }> = [];
    const provider = providerWithSend((type, input) => {
      if (type === 'ListObjectsV2') {
        return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
      }
      if (type === 'CopyObject') {
        copies.push(input as { Bucket: string; Key: string; CopySource: string });
        return {};
      }
      return {};
    });

    const { copied } = await provider.copyPrefix('app-bkt', 'state-bkt', '.pulumi/');
    expect(copied).toBe(2);
    expect(copies).toHaveLength(2);
    // Destination is the state bucket; keys are preserved.
    expect(copies.every((c) => c.Bucket === 'state-bkt')).toBe(true);
    expect(copies.map((c) => c.Key)).toEqual(keys);
    // CopySource is `<srcBucket>/<key>` URL-encoded (slashes preserved).
    expect(copies[0].CopySource).toBe('app-bkt/.pulumi/meta.yaml');
  });

  it('paginates via the continuation token', async () => {
    let listCall = 0;
    const provider = providerWithSend((type) => {
      if (type === 'ListObjectsV2') {
        listCall += 1;
        return listCall === 1
          ? { Contents: [{ Key: '.pulumi/a' }], IsTruncated: true, NextContinuationToken: 'tok' }
          : { Contents: [{ Key: '.pulumi/b' }], IsTruncated: false };
      }
      return {};
    });
    const { copied } = await provider.copyPrefix('src', 'dst', '.pulumi/');
    expect(copied).toBe(2);
    expect(listCall).toBe(2);
  });
});
