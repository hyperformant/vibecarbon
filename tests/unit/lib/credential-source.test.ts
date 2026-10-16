/**
 * describeCredentialSource names the store a key pair came from, so a line
 * like "Using S3 credentials from ..." points at the file or export to fix.
 * The old line said "environment variables" for keys that came from the
 * project's .env.local (excitingai, 2026-10-16).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDotenvLine } from '../../../src/lib/dotenv.js';
import { bootstrapOperatorEnv, describeCredentialSource } from '../../../src/lib/project.js';

const KEYS = ['HETZNER_ACCESS_KEY', 'HETZNER_SECRET_KEY'];
let dir: string;

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  if (dir) rmSync(dir, { recursive: true, force: true });
  bootstrapOperatorEnv(tmpdir());
});

describe('describeCredentialSource', () => {
  it("says .env.local when the project's file supplied the pair", () => {
    dir = mkdtempSync(join(tmpdir(), 'vc-credsrc-'));
    writeFileSync(
      join(dir, '.env.local'),
      [
        formatDotenvLine('HETZNER_ACCESS_KEY', 'ABCDEFGHIJ0123456789'),
        formatDotenvLine('HETZNER_SECRET_KEY', 'x'.repeat(40)),
        '',
      ].join('\n'),
    );
    bootstrapOperatorEnv(dir);
    expect(describeCredentialSource(KEYS)).toEqual({
      source: 'env-local',
      label: "your project's .env.local",
      where: "your project's .env.local",
    });
  });

  it('says shell environment, naming the variables, when an export supplied them', () => {
    dir = mkdtempSync(join(tmpdir(), 'vc-credsrc-'));
    process.env.HETZNER_ACCESS_KEY = 'ABCDEFGHIJ0123456789';
    process.env.HETZNER_SECRET_KEY = 'x'.repeat(40);
    bootstrapOperatorEnv(dir);
    expect(describeCredentialSource(KEYS)).toEqual({
      source: 'shell',
      label: 'your shell environment (HETZNER_ACCESS_KEY, HETZNER_SECRET_KEY)',
      where: 'your shell environment',
    });
  });
});
