import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { generateEnvLocal } from '../../../src/create.js';
import { parseDotenv } from '../../../src/lib/dotenv.js';

/**
 * The local dev S3 credentials live in three places that must agree, or dev
 * uploads fail with InvalidAccessKeyId:
 * - carbon/docker-compose.override.yml: the key the Garage container imports
 *   at start (GARAGE_DEFAULT_ACCESS_KEY / GARAGE_DEFAULT_SECRET_KEY).
 * - carbon/scripts/dev-init.js: the .env written for the repo's own dev stack.
 * - src/create.js: the .env written into a freshly created project.
 */

const ROOT = join(__dirname, '..', '..', '..');

function garageCredentials() {
  const compose = parseYaml(
    readFileSync(join(ROOT, 'carbon/docker-compose.override.yml'), 'utf-8'),
  ) as { services: { s3: { environment: Record<string, string> } } };
  const env = compose.services.s3.environment;
  return { accessKey: env.GARAGE_DEFAULT_ACCESS_KEY, secretKey: env.GARAGE_DEFAULT_SECRET_KEY };
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

describe('dev S3 credentials agree across the Garage service, dev-init.js and create.js', () => {
  const expected = garageCredentials();

  it('dev-init.js writes the key Garage imports', () => {
    expect(devInitCredentials()).toEqual(expected);
  });

  it('vibecarbon create writes the key Garage imports', () => {
    expect(createCredentials()).toEqual(expected);
  });
});
