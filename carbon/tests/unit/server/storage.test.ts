import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeEnv = vi.hoisted(() => ({
  S3_ENDPOINT: 'http://localhost:8333' as string | undefined,
  S3_REGION: 'us-east-1' as string | undefined,
  S3_BUCKET: 'test-bucket' as string | undefined,
  S3_ACCESS_KEY: 'test' as string | undefined,
  S3_SECRET_KEY: 'test' as string | undefined,
}));
vi.mock('@server/lib/env', () => ({ env: fakeEnv }));

import {
  buildObjectKey,
  isStorageConfigured,
  parseObjectKey,
  presignRead,
  presignUpload,
  StorageInputError,
  StorageNotConfiguredError,
} from '@server/lib/storage';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

beforeEach(() => {
  fakeEnv.S3_BUCKET = 'test-bucket';
});

describe('buildObjectKey', () => {
  it('builds an avatar key', () => {
    expect(buildObjectKey('avatar', 'u1', 'image/png')).toMatch(
      /^avatars\/u1\/[0-9a-f-]{36}\.png$/,
    );
  });
  it('rejects svg for avatar and html for private', () => {
    expect(() => buildObjectKey('avatar', 'u1', 'image/svg+xml')).toThrow(StorageInputError);
    expect(() => buildObjectKey('private', 'u1', 'text/html')).toThrow(StorageInputError);
  });
  it('maps pdf and falls back to bin', () => {
    expect(buildObjectKey('private', 'u1', 'application/pdf')).toMatch(/\.pdf$/);
    expect(buildObjectKey('private', 'u1', 'application/x-weird')).toMatch(/\.bin$/);
  });
});

describe('presignUpload', () => {
  it('rejects oversize and zero sizes', async () => {
    const base = { kind: 'avatar' as const, userId: 'u1', contentType: 'image/png' };
    await expect(presignUpload({ ...base, size: 2_097_153 })).rejects.toThrow(StorageInputError);
    await expect(presignUpload({ ...base, size: 0 })).rejects.toThrow(StorageInputError);
  });
  it('returns a signed url with signed headers', async () => {
    const r = await presignUpload({
      kind: 'avatar',
      userId: 'u1',
      contentType: 'image/png',
      size: 1000,
    });
    expect(r.url).toContain('X-Amz-Signature');
    expect(r.headers).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '1000' });
    expect(r.expiresIn).toBe(300);
    expect(r.key.startsWith('avatars/u1/')).toBe(true);
  });
  it('reports not-configured first', async () => {
    fakeEnv.S3_BUCKET = undefined;
    expect(isStorageConfigured()).toBe(false);
    await expect(
      presignUpload({ kind: 'avatar', userId: 'u1', contentType: 'image/png', size: 0 }),
    ).rejects.toThrow(StorageNotConfiguredError);
  });
});

describe('parseObjectKey', () => {
  it.each([
    'avatars/u1/../x.png',
    'avatars//x.png',
    `other/u1/${UUID}.png`,
    `avatars/u1/${UUID}`,
    `avatars%2Fu1/${UUID}.png`,
  ])('rejects %s', (k) => {
    expect(parseObjectKey(k)).toBeNull();
  });
  it('accepts a valid key', () => {
    const key = `avatars/u1/${UUID}.png`;
    expect(parseObjectKey(key)).toEqual({ kind: 'avatar', userId: 'u1', key });
  });
});

describe('presignRead', () => {
  it('signs a 300s GET url', async () => {
    const key = `private/u1/${UUID}.pdf`;
    const url = await presignRead(key);
    expect(new URL(url).pathname.endsWith(key)).toBe(true);
    expect(url).toContain('X-Amz-Expires=300');
  });
});
