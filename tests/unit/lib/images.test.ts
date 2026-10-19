import { describe, expect, it, vi } from 'vitest';
import {
  DB_IMAGE,
  DB_IMAGE_TAG,
  DEV_DB_IMAGE,
  dbImageRef,
  resolveDbImage,
} from '../../../src/lib/images.js';

describe('db image ref', () => {
  it('is the pre-published multi-arch tag (no project/sha/timestamp)', () => {
    expect(DB_IMAGE).toBe('ghcr.io/hyperformant/postgres');
    expect(DB_IMAGE_TAG).toBe('17.11-walg3.0.9-r2');
    expect(dbImageRef()).toBe('ghcr.io/hyperformant/postgres:17.11-walg3.0.9-r2');
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
