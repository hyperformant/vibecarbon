import { describe, expect, it, vi } from 'vitest';
import {
  DB_IMAGE,
  DB_IMAGE_TAG,
  DEV_DB_IMAGE,
  localComposeEnv,
  setDbImageWarningSink,
} from '../../../src/lib/images.js';

/**
 * Every local compose run (`vibecarbon up`, `down`, `reset`, the `compose ps`
 * probes) hands compose the CLI's db image, through the
 * environment (which compose ranks above .env). The .env never decides: a
 * project whose .env lacks the pair still starts, and a dev-channel ref a past
 * `create` persisted is replaced by the release pin once VIBECARBON_DB_IMAGE
 * is unset. The compose half of that precedence is proven against the real
 * compose file in tests/integration/docker/db-image-compose-env.test.ts.
 */
describe('localComposeEnv: the db image every local compose run gets', () => {
  const DEV = `${DEV_DB_IMAGE}:${DB_IMAGE_TAG}-0123456789ab`;

  it('no override, .env lacking the keys: the release pair', () => {
    const env = localComposeEnv({ PATH: '/bin' });
    expect(env).toMatchObject({ DB_IMAGE, DB_IMAGE_TAG, PATH: '/bin' });
  });

  it('no override, a persisted dev ref in .env: still the release pair', () => {
    // A shell that exported the stale pair too loses to the resolver.
    const env = localComposeEnv({
      DB_IMAGE: DEV_DB_IMAGE,
      DB_IMAGE_TAG: `${DB_IMAGE_TAG}-0123456789ab`,
    });
    expect(env).toMatchObject({ DB_IMAGE, DB_IMAGE_TAG });
  });

  it('override set: that ref, with the dev-image warning', () => {
    const warn = vi.fn();
    setDbImageWarningSink(warn);
    try {
      const env = localComposeEnv({ VIBECARBON_DB_IMAGE: DEV });
      expect(env).toMatchObject({
        DB_IMAGE: DEV_DB_IMAGE,
        DB_IMAGE_TAG: `${DB_IMAGE_TAG}-0123456789ab`,
      });
      expect(warn).toHaveBeenCalledWith(`using dev db image ${DEV}; not for production`);
    } finally {
      setDbImageWarningSink((msg) => process.stderr.write(`warning: ${msg}\n`));
    }
  });
});
