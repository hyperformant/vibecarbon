/**
 * destroy S3-config/keys mismatch warning (roadmap item found 2026-07-25
 * during providers-configure): when `envConfig.s3` is present but the S3 env
 * keys are absent, destroy used to proceed silently and could leave the bucket
 * behind. It must now loud-warn BEFORE the teardown starts and feed the leak
 * tally as a leak-RISK line.
 */
import { describe, expect, it } from 'vitest';
import { checkS3CredentialMismatch } from '../../../src/lib/destroy/s3-credential-check.js';

const HETZNER_KEYS: [string, string] = ['HETZNER_ACCESS_KEY', 'HETZNER_SECRET_KEY'];
const BOTH_SET = { HETZNER_ACCESS_KEY: 'ak', HETZNER_SECRET_KEY: 'sk' };

describe('checkS3CredentialMismatch', () => {
  it('is silent when both keys are present', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod', region: 'fsn1' } },
      envKeys: HETZNER_KEYS,
      env: BOTH_SET,
    });
    expect(risks).toEqual([]);
  });

  it('is silent when no bucket is recorded — nothing to leave behind', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: {},
      envKeys: HETZNER_KEYS,
      env: {},
    });
    expect(risks).toEqual([]);
  });

  it('flags the app bucket when both keys are missing, naming both vars', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod', region: 'fsn1' } },
      envKeys: HETZNER_KEYS,
      env: {},
    });
    expect(risks).toHaveLength(1);
    expect(risks[0].resourceClass).toBe('bucket');
    expect(risks[0].resource).toBe('acme-prod (fsn1)');
    expect(risks[0].reason).toContain('HETZNER_ACCESS_KEY');
    expect(risks[0].reason).toContain('HETZNER_SECRET_KEY');
    expect(risks[0].hint).toBeTruthy();
  });

  it('flags a HALF-configured pair — one missing key is the same leak', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod' } },
      envKeys: HETZNER_KEYS,
      env: { HETZNER_ACCESS_KEY: 'ak' },
    });
    expect(risks).toHaveLength(1);
    expect(risks[0].reason).toContain('HETZNER_SECRET_KEY');
    expect(risks[0].reason).not.toContain('HETZNER_ACCESS_KEY is');
  });

  it('never flags the state bucket — destroy keeps it, so it is not at risk', () => {
    // Inverted 2026-08-15: destroy retains the dedicated Pulumi state bucket
    // (retainStateBucket), so a credential-less destroy will not try to delete
    // it and an AT-RISK entry for it was false — it made every credential-less
    // destroy print 'with observations' and wrong billing advice for a bucket
    // we keep on purpose.
    const risks = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod', stateBucket: 'acme-prod-state', region: 'fsn1' } },
      envKeys: HETZNER_KEYS,
      env: {},
    });
    expect(risks.map((r) => r.resource)).toEqual(['acme-prod (fsn1)']);
  });

  it('still reports only the app bucket for pre-split envs (state IS the app bucket)', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod', stateBucket: 'acme-prod' } },
      envKeys: HETZNER_KEYS,
      env: {},
    });
    expect(risks).toHaveLength(1);
  });

  it('ignores the backup bucket without -purge — it is deliberately preserved', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { backupS3: { bucket: 'acme-prod-backups', region: 'fsn1' } },
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: false,
    });
    expect(risks).toEqual([]);
  });

  it('flags the backup bucket with -purge, since destroy will try to delete it', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { backupS3: { bucket: 'acme-prod-backups', region: 'fsn1' } },
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: true,
    });
    expect(risks).toHaveLength(1);
    expect(risks[0].resource).toContain('acme-prod-backups');
  });

  it('softens the wording when an interactive prompt can still supply the keys', () => {
    const [offTty] = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod' } },
      envKeys: HETZNER_KEYS,
      env: {},
      canPrompt: false,
    });
    const [onTty] = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod' } },
      envKeys: HETZNER_KEYS,
      env: {},
      canPrompt: true,
    });
    expect(offTty.reason).toMatch(/will be skipped|survive/i);
    expect(onTty.reason).toMatch(/prompt/i);
  });

  it('names the DigitalOcean pair when that is the provider, never Hetzner keys', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod', region: 'sfo3' } },
      envKeys: ['DIGITALOCEAN_ACCESS_KEY', 'DIGITALOCEAN_SECRET_KEY'],
      env: {},
    });
    expect(risks[0].reason).toContain('DIGITALOCEAN_ACCESS_KEY');
    expect(risks[0].reason).not.toContain('HETZNER_ACCESS_KEY');
  });

  it('is silent when the provider declares no object-storage env pair', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod' } },
      envKeys: [],
      env: {},
    });
    expect(risks).toEqual([]);
  });
});
