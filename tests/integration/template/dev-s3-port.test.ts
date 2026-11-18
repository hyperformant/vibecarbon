import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devS3Port } from '../../../src/lib/dev-s3.js';
import { REPO_ROOT } from '../../_shared/source-files.js';
import { createTempDir } from '../../_shared/temp-dir.js';

/**
 * docker-up.js publishes the local S3 on the port S3_ENDPOINT names: two
 * offsets, two distinct DEV_S3_PORT values, each equal to the CLI's rule
 * (the one setPortOffset writes into S3_ENDPOINT, tests/unit/lib/dev-s3-port.test.ts).
 */

const DOCKER_UP = join(REPO_ROOT, 'carbon', 'scripts', 'docker-up.js');

function publishedS3Port(envLocal: string): number {
  const dir = createTempDir('vc-dev-s3-up-');
  writeFileSync(join(dir, '.env.local'), envLocal);
  const out = execFileSync('node', [DOCKER_UP, '--dry-run'], {
    cwd: dir,
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '' },
  });
  const m = out.match(/DEV_S3_PORT: '(\d+)'/);
  expect(m, out).not.toBeNull();
  return Number((m as RegExpMatchArray)[1]);
}

describe('docker-up.js publishes DEV_S3_PORT on the shared rule', () => {
  it('two offsets give two distinct ports, the ones S3_ENDPOINT is written with', () => {
    const a = publishedS3Port('DEV_PORT_OFFSET=100\n');
    const b = publishedS3Port('DEV_PORT_OFFSET=200\n');
    expect([a, b]).toEqual([
      devS3Port({ DEV_PORT_OFFSET: '100' }),
      devS3Port({ DEV_PORT_OFFSET: '200' }),
    ]);
    expect(a).not.toBe(b);
  });

  it('an explicit DEV_S3_PORT wins', () => {
    expect(publishedS3Port('DEV_PORT_OFFSET=100\nDEV_S3_PORT=9000\n')).toBe(9000);
  });
});
