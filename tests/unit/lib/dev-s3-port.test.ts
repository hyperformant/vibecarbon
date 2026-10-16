import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateEnvLocal } from '../../../src/create.js';
import { devS3Endpoint, devS3Port } from '../../../src/lib/dev-s3.js';
import { parseDotenv } from '../../../src/lib/dotenv.js';
import { setPortOffset } from '../../../src/up.js';

/**
 * The dev-only local S3 port follows the DEV_* port contract (explicit
 * DEV_S3_PORT, else 8333 + DEV_PORT_OFFSET), so two local projects on
 * different offsets publish different ports, and S3_ENDPOINT in each
 * project's .env.local names its own. docker-up.js's side is pinned in
 * tests/integration/template/dev-s3-port.test.ts.
 */

const ROOT = join(__dirname, '..', '..', '..');

describe('devS3Port', () => {
  it('is one rule in two byte-identical copies (CLI and template)', () => {
    expect(readFileSync(join(ROOT, 'src/lib/dev-s3.js'), 'utf-8')).toBe(
      readFileSync(join(ROOT, 'carbon/scripts/lib/dev-s3.js'), 'utf-8'),
    );
  });

  it('shifts with DEV_PORT_OFFSET and lets DEV_S3_PORT win', () => {
    expect(devS3Port({})).toBe(8333);
    expect(devS3Port({ DEV_PORT_OFFSET: '100' })).toBe(8433);
    expect(devS3Port({ DEV_PORT_OFFSET: '100', DEV_S3_PORT: '9000' })).toBe(9000);
    expect(devS3Endpoint({ DEV_PORT_OFFSET: '200' })).toBe('http://localhost:8533');
  });
});

describe('S3_ENDPOINT follows the offset', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-dev-s3-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const env = () => parseDotenv(readFileSync(join(dir, '.env.local'), 'utf-8'));

  it('create writes the base-port endpoint for its offset', () => {
    const created = parseDotenv(
      generateEnvLocal('two-app', {
        PROJECT_NAME: 'two-app',
        PROJECT_DISPLAY_NAME: 'Two App',
        SITE_URL: 'http://localhost:5173',
        ADMIN_EMAIL: 'admin@example.com',
      }),
    );
    expect(created.S3_ENDPOINT).toBe(devS3Endpoint(created));
  });

  it('two offsets give two distinct ports, each matching its endpoint', () => {
    const seen = new Set<number>();
    for (const offset of [100, 200]) {
      writeFileSync(
        join(dir, '.env.local'),
        'S3_ENDPOINT=http://localhost:8333\nDEV_PORT_OFFSET=0\n',
      );
      setPortOffset(offset, dir);
      const port = devS3Port(env());
      seen.add(port);
      expect(env().S3_ENDPOINT).toBe(`http://localhost:${port}`);
    }
    expect([...seen]).toEqual([8433, 8533]);
  });

  it('keeps an explicit DEV_S3_PORT', () => {
    writeFileSync(
      join(dir, '.env.local'),
      'S3_ENDPOINT=http://localhost:9000\nDEV_S3_PORT=9000\nDEV_PORT_OFFSET=0\n',
    );
    setPortOffset(100, dir);
    expect(env().S3_ENDPOINT).toBe('http://localhost:9000');
  });

  it('leaves a real bucket endpoint alone', () => {
    writeFileSync(join(dir, '.env.local'), 'S3_ENDPOINT=https://fsn1.your-objectstorage.com\n');
    setPortOffset(100, dir);
    expect(env().S3_ENDPOINT).toBe('https://fsn1.your-objectstorage.com');
  });
});
