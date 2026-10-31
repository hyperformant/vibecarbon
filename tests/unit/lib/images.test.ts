import { describe, expect, it, vi } from 'vitest';
import {
  DB_IMAGE,
  DB_IMAGE_TAG,
  DEV_DB_IMAGE,
  dbImageRef,
  NODE_RUNTIME_IMAGE,
  resolveDbImage,
} from '../../../src/lib/images.js';

describe('node runtime base image ref', () => {
  it('is the pre-published revision tag the app image builds FROM', () => {
    // The tag part; the post-publish commit appends @sha256 without moving it.
    expect(NODE_RUNTIME_IMAGE.split('@')[0]).toBe(
      'ghcr.io/hyperformant/node-runtime:24-alpine3.24-r2',
    );
  });
  it('follows <node major>-alpine<alpine minor>-r<N>, optionally @sha256 once published', () => {
    // Pre-publish the tag alone; the post-publish commit appends the index
    // digest (release.yml refuses to release without it).
    expect(NODE_RUNTIME_IMAGE).toMatch(
      /^ghcr\.io\/hyperformant\/node-runtime:\d+-alpine\d+\.\d+-r[1-9]\d*(@sha256:[a-f0-9]{64})?$/,
    );
  });
});

describe('db image ref', () => {
  it('is the pre-published multi-arch tag (no project/sha/timestamp)', () => {
    expect(DB_IMAGE).toBe('ghcr.io/hyperformant/postgres');
    expect(DB_IMAGE_TAG).toBe('17.11-walg3.0.9-r3');
    expect(dbImageRef()).toBe('ghcr.io/hyperformant/postgres:17.11-walg3.0.9-r3');
  });
  it('ref is stable — never per-deploy unique', () => {
    expect(dbImageRef()).toBe(dbImageRef());
    expect(dbImageRef()).not.toMatch(/dirty|\d{14}/); // no -dirty / timestamp
  });
});

describe('resolveDbImage (VIBECARBON_DB_IMAGE override)', () => {
  const DEV = `${DEV_DB_IMAGE}:${DB_IMAGE_TAG}-0123456789ab`;

  it('unset: the pinned release, no warning', () => {
    const warn = vi.fn();
    for (const env of [{}, { VIBECARBON_DB_IMAGE: '' }, { VIBECARBON_DB_IMAGE: '  ' }]) {
      expect(resolveDbImage({ env, warn })).toEqual({
        image: DB_IMAGE,
        tag: DB_IMAGE_TAG,
        ref: dbImageRef(),
        override: false,
      });
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('set: exactly that ref, split into repo + tag, with the warning', () => {
    const warn = vi.fn();
    expect(resolveDbImage({ env: { VIBECARBON_DB_IMAGE: DEV }, warn })).toEqual({
      image: DEV_DB_IMAGE,
      tag: `${DB_IMAGE_TAG}-0123456789ab`,
      ref: DEV,
      override: true,
    });
    expect(warn).toHaveBeenCalledWith(`using dev db image ${DEV}; not for production`);
  });

  it('keeps a registry port in the repository', () => {
    const r = resolveDbImage({ env: { VIBECARBON_DB_IMAGE: 'localhost:5000/pg:t1' }, warn() {} });
    expect([r.image, r.tag]).toEqual(['localhost:5000/pg', 't1']);
  });

  it.each([
    'ghcr.io/hyperformant/postgres-dev',
    'localhost:5000/pg',
    'ghcr.io/hyperformant/postgres-dev@sha256:abc',
    'ghcr.io/x/pg:',
    'ghcr.io/x/pg:a b',
  ])('refuses a ref with no usable tag: %s', (bad) => {
    expect(() => resolveDbImage({ env: { VIBECARBON_DB_IMAGE: bad }, warn() {} })).toThrow(
      /VIBECARBON_DB_IMAGE must be a full image ref/,
    );
  });

  it('the default reads process.env', () => {
    const saved = process.env.VIBECARBON_DB_IMAGE;
    process.env.VIBECARBON_DB_IMAGE = DEV;
    try {
      expect(resolveDbImage({ warn() {} }).ref).toBe(DEV);
    } finally {
      if (saved === undefined) delete process.env.VIBECARBON_DB_IMAGE;
      else process.env.VIBECARBON_DB_IMAGE = saved;
    }
  });
});
