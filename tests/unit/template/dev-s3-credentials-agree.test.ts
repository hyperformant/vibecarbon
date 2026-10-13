import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateEnvLocal } from '../../../src/create.js';
import { parseDotenv } from '../../../src/lib/dotenv.js';

/**
 * The local dev S3 credentials live in three places that must agree, or dev
 * uploads fail with InvalidAccessKeyId:
 * - carbon/volumes/s3/s3.json: the identity the SeaweedFS container accepts.
 * - carbon/scripts/dev-init.js: the .env written for the repo's own dev stack.
 * - src/create.js: the .env written into a freshly created project.
 */

const ROOT = join(__dirname, '..', '..', '..');

function seaweedCredentials() {
  const config = JSON.parse(readFileSync(join(ROOT, 'carbon/volumes/s3/s3.json'), 'utf-8')) as {
    identities: Array<{ credentials: Array<{ accessKey: string; secretKey: string }> }>;
  };
  const creds = config.identities.flatMap((i) => i.credentials);
  expect(creds).toHaveLength(1);
  return creds[0];
}

// dev-init.js runs on import (it writes .env files), so read its DEV constants
// from source instead.
function devInitCredentials() {
  const src = readFileSync(join(ROOT, 'carbon/scripts/dev-init.js'), 'utf-8');
  const pick = (name: string) => {
    const m = src.match(new RegExp(`^\\s*${name}: '([^']+)',$`, 'm'));
    expect(m, `${name} literal in dev-init.js DEV`).not.toBeNull();
    return (m as RegExpMatchArray)[1];
  };
  return { accessKey: pick('S3_ACCESS_KEY'), secretKey: pick('S3_SECRET_KEY') };
}

function createCredentials() {
  const env = parseDotenv(
    generateEnvLocal('creds-app', {
      PROJECT_NAME: 'creds-app',
      PROJECT_DISPLAY_NAME: 'Creds App',
      SITE_URL: 'http://localhost:5173',
      ADMIN_EMAIL: 'admin@example.com',
    }),
  );
  return { accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY };
}

describe('dev S3 credentials agree across s3.json, dev-init.js and create.js', () => {
  const expected = seaweedCredentials();

  it('dev-init.js writes the identity s3.json accepts', () => {
    expect(devInitCredentials()).toEqual(expected);
  });

  it('vibecarbon create writes the identity s3.json accepts', () => {
    expect(createCredentials()).toEqual(expected);
  });
});
