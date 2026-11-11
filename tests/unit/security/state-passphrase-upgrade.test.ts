import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDotenv } from '../../../src/lib/dotenv.js';
import {
  __resetStatePassphraseForTests,
  statePassphraseFingerprint,
} from '../../../src/lib/state-passphrase.js';
import { ensureStatePassphraseForUpgrade } from '../../../src/upgrade.js';

/**
 * A project created before the per-project state passphrase gets one when
 * `upgrade` runs, the way it gets BETTER_AUTH_SECRET: the value in .env.local
 * only (the operator's file, never shipped), its fingerprint in
 * .vibecarbon.json. A second run changes nothing.
 */
describe('upgrade backfills the state passphrase', () => {
  let dir: string;
  beforeEach(() => {
    vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', undefined);
    __resetStatePassphraseForTests();
    dir = mkdtempSync(join(tmpdir(), 'vc-spu-'));
    writeFileSync(join(dir, '.vibecarbon.json'), '{"projectName":"demo"}\n');
    writeFileSync(join(dir, '.env.local'), 'PROJECT_NAME=demo\n');
    writeFileSync(join(dir, '.env'), 'PROJECT_NAME=demo\n');
  });
  afterEach(() => vi.unstubAllEnvs());

  const read = (file: string) => readFileSync(join(dir, file), 'utf-8');
  const valueIn = (file: string) => parseDotenv(read(file)).VIBECARBON_STATE_PASSPHRASE;

  it('generates one into .env.local only and records its fingerprint', async () => {
    expect(await ensureStatePassphraseForUpgrade(dir)).toBe('generated');

    const value = valueIn('.env.local');
    expect(value?.length).toBeGreaterThanOrEqual(43);
    // SECURITY: .env is the file a deploy ships.
    expect(read('.env')).not.toContain('VIBECARBON_STATE_PASSPHRASE');
    expect(JSON.parse(read('.vibecarbon.json')).stateEncryption.fingerprint).toBe(
      statePassphraseFingerprint(value as string),
    );
    // The fingerprint is committed; the value never is.
    expect(read('.vibecarbon.json')).not.toContain(value as string);
  });

  it('is idempotent: a second run changes nothing and makes no new passphrase', async () => {
    await ensureStatePassphraseForUpgrade(dir);
    const before = { local: read('.env.local'), config: read('.vibecarbon.json') };
    __resetStatePassphraseForTests();

    expect(await ensureStatePassphraseForUpgrade(dir)).toBeNull();

    expect(read('.env.local')).toBe(before.local);
    expect(read('.vibecarbon.json')).toBe(before.config);
  });

  it('records the fingerprint of a value already in .env.local, and keeps the value', async () => {
    const mine = 'a'.repeat(43);
    writeFileSync(
      join(dir, '.env.local'),
      `PROJECT_NAME=demo\nVIBECARBON_STATE_PASSPHRASE=${mine}\n`,
    );

    // The CLI folds .env.local into the environment at startup.
    vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', mine);
    expect(await ensureStatePassphraseForUpgrade(dir)).toBe('recorded');

    expect(valueIn('.env.local')).toBe(mine);
    expect(JSON.parse(read('.vibecarbon.json')).stateEncryption.fingerprint).toBe(
      statePassphraseFingerprint(mine),
    );
  });

  it('-dry writes nothing and says what it would do', async () => {
    expect(await ensureStatePassphraseForUpgrade(dir, { dryRun: true })).toBe('generated');
    expect(read('.env.local')).toBe('PROJECT_NAME=demo\n');
    expect(read('.vibecarbon.json')).toBe('{"projectName":"demo"}\n');
  });

  it('-dry on a project that already has one reports nothing to do', async () => {
    await ensureStatePassphraseForUpgrade(dir);
    expect(await ensureStatePassphraseForUpgrade(dir, { dryRun: true })).toBeNull();
  });

  it('a recorded fingerprint whose value is missing is a warning, not a new passphrase', async () => {
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({ stateEncryption: { fingerprint: 'sha256:0123456789abcdef' } }),
    );

    await expect(ensureStatePassphraseForUpgrade(dir)).resolves.toBe('problem');
    expect(read('.env.local')).toBe('PROJECT_NAME=demo\n');
  });
});
