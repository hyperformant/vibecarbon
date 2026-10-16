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
  it.each(['TEXT/HTML', 'text/html; charset=utf-8'])('rejects %s for both kinds', (t) => {
    expect(() => buildObjectKey('avatar', 'u1', t)).toThrow(StorageInputError);
    expect(() => buildObjectKey('private', 'u1', t)).toThrow(StorageInputError);
  });
  it('rejects private application/zip (allowlist)', () => {
    expect(() => buildObjectKey('private', 'u1', 'application/zip')).toThrow(StorageInputError);
  });
  it('maps pdf to .pdf', () => {
    expect(buildObjectKey('private', 'u1', 'application/pdf')).toMatch(/\.pdf$/);
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
  it('embeds no checksum params and signs content-length and content-type', async () => {
    const r = await presignUpload({
      kind: 'avatar',
      userId: 'u1',
      contentType: 'image/png',
      size: 1000,
    });
    const lower = r.url.toLowerCase();
    expect(lower).not.toContain('x-amz-checksum');
    expect(lower).not.toContain('x-amz-sdk-checksum-algorithm');
    const signed = new URL(r.url).searchParams.get('X-Amz-SignedHeaders') ?? '';
    expect(signed.split(';')).toEqual(expect.arrayContaining(['content-length', 'content-type']));
  });
  it('enforces the private kind 10 MB limit', async () => {
    const base = { kind: 'private' as const, userId: 'u1', contentType: 'application/pdf' };
    const ok = await presignUpload({ ...base, size: 10_485_760 });
    expect(ok.key).toMatch(/^private\/u1\/.*\.pdf$/);
    await expect(presignUpload({ ...base, size: 10_485_761 })).rejects.toThrow(StorageInputError);
  });
  it('normalizes content type in the signed headers', async () => {
    const r = await presignUpload({
      kind: 'avatar',
      userId: 'u1',
      contentType: 'image/PNG; charset=x',
      size: 10,
    });
    expect(r.headers['Content-Type']).toBe('image/png');
    expect(r.key).toMatch(/\.png$/);
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
  it('forces attachment for private reads only', async () => {
    const priv = await presignRead(`private/u1/${UUID}.pdf`);
    expect(priv).toContain('response-content-disposition=attachment');
    const av = await presignRead(`avatars/u1/${UUID}.png`);
    expect(av).not.toContain('response-content-disposition');
  });
});
