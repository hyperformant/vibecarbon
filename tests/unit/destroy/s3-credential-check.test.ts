/**
 * destroy S3-config/keys mismatch warning (roadmap item found 2026-07-25
 * during providers-configure): when `envConfig.s3` is present but the S3 env
 * keys are absent, destroy used to proceed silently and could leave the bucket
 * behind. It must now loud-warn BEFORE the teardown starts and feed the leak
 * tally as a leak-RISK line.
 *
 * Only for what this destroy will touch:
 * - On every destroy, the Pulumi stack state in object storage: without the
 *   keys it stays, the entry is kept, and the rerun the hint names can run.
 * - Under -purge, the environment's own app bucket and its backups bucket,
 *   or only its folder there while other environments keep backups in it.
 *   Those hints give by-hand steps, never a destroy rerun: a delete is
 *   skipped for want of keys only when the entry moves (a kept entry keeps
 *   its buckets for the rerun).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      purgeBackups: true,
    });
    expect(risks).toEqual([]);
  });

  it('reads the injected env through the normalizing reader (a padded/quoted paste counts as present)', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod', region: 'fsn1' } },
      envKeys: HETZNER_KEYS,
      env: { HETZNER_ACCESS_KEY: '"ak"\n', HETZNER_SECRET_KEY: ' sk ' },
      purgeBackups: true,
    });
    expect(risks).toEqual([]);
  });

  it('treats a blank value as missing, like the destroy credential resolution does', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod', region: 'fsn1' } },
      envKeys: HETZNER_KEYS,
      env: { HETZNER_ACCESS_KEY: '   ', HETZNER_SECRET_KEY: 'sk' },
      purgeBackups: true,
    });
    expect(risks).toHaveLength(1);
    expect(risks[0].reason).toContain('HETZNER_ACCESS_KEY is not set');
  });

  it('is silent when no bucket is recorded — nothing to leave behind', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: {},
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: true,
    });
    expect(risks).toEqual([]);
  });

  it('flags the app bucket -purge deletes when both keys are missing, naming both vars', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod', region: 'fsn1' } },
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: true,
    });
    expect(risks).toHaveLength(1);
    expect(risks[0].resourceClass).toBe('bucket');
    expect(risks[0].resource).toBe('acme-prod (fsn1)');
    expect(risks[0].reason).toContain('HETZNER_ACCESS_KEY');
    expect(risks[0].reason).toContain('HETZNER_SECRET_KEY');
  });

  it('gives by-hand steps, never a destroy rerun, which finds no environment by the time the report shows', () => {
    const [risk] = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod', region: 'fsn1' } },
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: true,
    });
    expect(risk.hint).toBe(
      "If its delete is skipped, the leak report gives the console steps for it. Next time, set HETZNER_ACCESS_KEY and HETZNER_SECRET_KEY (shell or the project's .env.local) before the destroy, so it can delete the bucket itself.",
    );
    expect(risk.hint).not.toMatch(/re-?run|\u2014/i);
  });

  it('names no bucket on a plain destroy, which keeps every bucket', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: {
        s3: { bucket: 'acme-prod', stateBucket: 'acme-prod-state', region: 'fsn1' },
        backupS3: { bucket: 'acme-backups', region: 'fsn1' },
      },
      envKeys: HETZNER_KEYS,
      env: {},
    });
    expect(risks).toEqual([]);
  });

  it('leaves out an app bucket -purge keeps (pinned, or an older per-project one)', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: {
        s3: { bucket: 'acme-storage', region: 'fsn1' },
        backupS3: { bucket: 'acme-backups', region: 'fsn1' },
      },
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: true,
      appBucketOwned: false,
    });
    expect(risks.map((r) => r.resource)).toEqual(['acme-backups (fsn1)']);
  });

  it('leaves out a backups record with no region anywhere: the purge refuses it before asking a store', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { backupS3: { bucket: 'acme-backups' } },
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: true,
    });
    expect(risks).toEqual([]);
  });

  it('flags a HALF-configured pair — one missing key is the same leak', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod' } },
      envKeys: HETZNER_KEYS,
      env: { HETZNER_ACCESS_KEY: 'ak' },
      purgeBackups: true,
    });
    expect(risks).toHaveLength(1);
    expect(risks[0].reason).toContain('HETZNER_SECRET_KEY');
    expect(risks[0].reason).not.toContain('HETZNER_ACCESS_KEY is');
  });

  it('never flags the state bucket: a plain destroy keeps it, and a -purge that deletes it records its own leak', () => {
    // Inverted 2026-08-15: destroy retains the dedicated Pulumi state bucket
    // (retainStateBucket), so an AT-RISK entry for it was false on every
    // credential-less plain destroy. A last-environment -purge deletes it
    // under rules only retainStateBucket applies, and records a leak with
    // the console steps when it has no keys.
    const risks = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod', stateBucket: 'acme-prod-state', region: 'fsn1' } },
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: true,
    });
    expect(risks.map((r) => r.resource)).toEqual(['acme-prod (fsn1)']);
  });

  it('still reports only the app bucket for pre-split envs (state IS the app bucket)', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod', stateBucket: 'acme-prod' } },
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: true,
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

  it("labels each bucket with its own region: the backups target's, not the uploads'", () => {
    const risks = checkS3CredentialMismatch({
      envConfig: {
        s3: { bucket: 'acme-staging', region: 'fsn1' },
        backupS3: { bucket: 'acme-backups', region: 'nbg1' },
      },
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: true,
    });
    expect(risks.map((r) => r.resource)).toEqual(['acme-staging (fsn1)', 'acme-backups (nbg1)']);
  });

  it('a backups record without a region sits beside the uploads (backupsTargetOf)', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: {
        s3: { bucket: 'acme-prod', region: 'fsn1' },
        backupS3: { bucket: 'acme-backups' },
      },
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: true,
    });
    expect(risks.map((r) => r.resource)).toEqual(['acme-prod (fsn1)', 'acme-backups (fsn1)']);
  });

  it('softens the wording when an interactive prompt can still supply the keys', () => {
    const [offTty] = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod' } },
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: true,
      canPrompt: false,
    });
    const [onTty] = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod' } },
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: true,
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
      purgeBackups: true,
    });
    expect(risks[0].reason).toContain('DIGITALOCEAN_ACCESS_KEY');
    expect(risks[0].reason).not.toContain('HETZNER_ACCESS_KEY');
  });

  it('is silent when the provider declares no object-storage env pair', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: { s3: { bucket: 'acme-prod' } },
      envKeys: [],
      env: {},
      purgeBackups: true,
    });
    expect(risks).toEqual([]);
  });
});

describe('the stack state every destroy opens', () => {
  const STAGING = {
    s3: { bucket: 'myapp-cd9ecc-staging-storage', stateBucket: 'myapp-state', region: 'fsn1' },
    backupS3: { bucket: 'myapp-cd9ecc-backups', region: 'fsn1' },
  };

  it('warns a plain destroy that the stack state and the entry stay, and names the rerun', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: STAGING,
      envKeys: HETZNER_KEYS,
      env: {},
      environment: 'staging',
      stackEnvs: ['staging'],
    });
    expect(risks).toEqual([
      {
        resourceClass: 'pulumi-stack',
        resource: 'staging',
        reason:
          'this environment keeps its Pulumi stack state in object storage but HETZNER_ACCESS_KEY ' +
          "and HETZNER_SECRET_KEY are not set: destroy cannot open it, so the stack state and the environment's " +
          'entry in .vibecarbon.json are kept for a rerun',
        hint:
          "Set HETZNER_ACCESS_KEY and HETZNER_SECRET_KEY (shell or the project's .env.local) before " +
          'the destroy, so it can open the stack state. If this one runs without them, set them and ' +
          'run `vibecarbon destroy staging` again: the kept entry lets that rerun finish.',
      },
    ]);
  });

  it('names both stacks of an HA environment', () => {
    const [risk] = checkS3CredentialMismatch({
      envConfig: STAGING,
      envKeys: HETZNER_KEYS,
      env: {},
      environment: 'prod',
      stackEnvs: ['prod-primary', 'prod-standby'],
    });
    expect(risk.resource).toBe('prod-primary, prod-standby');
  });

  it('is silent with the keys set, with no object storage recorded, or with no stack to open', () => {
    const base = { envKeys: HETZNER_KEYS, environment: 'staging' };
    expect(
      checkS3CredentialMismatch({
        ...base,
        envConfig: STAGING,
        env: BOTH_SET,
        stackEnvs: ['staging'],
      }),
    ).toEqual([]);
    // No envConfig.s3: the state is in no bucket, so no key opens it.
    expect(
      checkS3CredentialMismatch({ ...base, envConfig: {}, env: {}, stackEnvs: ['staging'] }),
    ).toEqual([]);
    // An unrecorded deploy (planDestroyTargets) opens no stack.
    expect(
      checkS3CredentialMismatch({ ...base, envConfig: STAGING, env: {}, stackEnvs: [] }),
    ).toEqual([]);
  });

  it('off a TTY under -purge, says the buckets stay for the -purge rerun, in that one line', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: STAGING,
      envKeys: HETZNER_KEYS,
      env: {},
      environment: 'staging',
      stackEnvs: ['staging'],
      purgeBackups: true,
    });
    expect(risks.map((r) => r.resourceClass)).toEqual(['pulumi-stack']);
    expect(risks[0].reason).toMatch(
      /kept for a rerun; -purge keeps its buckets for that rerun too$/,
    );
    expect(risks[0].hint).toContain('run `vibecarbon destroy staging -purge` again');
  });

  it('on a TTY, keeps the bucket lines beside it: the prompt can get the keys and then be declined', () => {
    const risks = checkS3CredentialMismatch({
      envConfig: STAGING,
      envKeys: HETZNER_KEYS,
      env: {},
      environment: 'staging',
      stackEnvs: ['staging'],
      purgeBackups: true,
      canPrompt: true,
    });
    expect(risks.map((r) => r.resource)).toEqual([
      'staging',
      'myapp-cd9ecc-staging-storage (fsn1)',
      'myapp-cd9ecc-backups (fsn1)',
    ]);
    expect(risks[0].reason).toContain(
      "declining the prompt keeps the stack state and the environment's entry in .vibecarbon.json for a rerun",
    );
    expect(risks[0].reason).not.toContain('-purge keeps its buckets');
  });
});

describe('a backups bucket other environments keep backups in', () => {
  const STAGING = { backupS3: { bucket: 'myapp-cd9ecc-backups', region: 'fsn1' } };

  it("names only this environment's folder, which is all -purge deletes there", () => {
    const risks = checkS3CredentialMismatch({
      envConfig: STAGING,
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: true,
      backupsHolders: ['prod'],
      backupsPrefix: 'backups/myapp/staging/',
    });
    expect(risks).toEqual([
      {
        resourceClass: 'bucket',
        resource: 'backups/myapp/staging/ in myapp-cd9ecc-backups (fsn1)',
        reason:
          'this environment keeps its backups in a bucket where prod keeps backups too, but ' +
          'HETZNER_ACCESS_KEY and HETZNER_SECRET_KEY are not set: the delete will be skipped and ' +
          "this environment's backups stay there, still billing",
        hint:
          'If the delete is skipped, the leak report gives the console steps for it. Next time, set ' +
          "HETZNER_ACCESS_KEY and HETZNER_SECRET_KEY (shell or the project's .env.local) before the " +
          "destroy, so it can delete this environment's backups itself.",
      },
    ]);
    expect(risks[0].reason).not.toMatch(/bucket will survive/);
  });

  it('names every holder, and on a TTY says declining leaves the backups there', () => {
    const [risk] = checkS3CredentialMismatch({
      envConfig: STAGING,
      envKeys: HETZNER_KEYS,
      env: {},
      purgeBackups: true,
      backupsHolders: ['prod', 'preview'],
      backupsPrefix: 'backups/myapp/staging/',
      canPrompt: true,
    });
    expect(risk.reason).toContain('where prod, preview keep backups too');
    expect(risk.reason).toContain(
      "declining the prompt leaves this environment's backups there, still billing",
    );
  });
});

describe('destroy wires the check to the app bucket rule it applies', () => {
  it('passes ownsAppBucket, the rule deleteAppBucketEffect deletes by', () => {
    const src = readFileSync(join(process.cwd(), 'src/destroy.js'), 'utf-8');
    const at = src.indexOf('checkS3CredentialMismatch({');
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, src.indexOf('})', at));
    expect(call).toContain('appBucketOwned: ownsAppBucket(envConfig, projectConfig, envName),');
    expect(src.indexOf('checkS3CredentialMismatch({', at + 1)).toBe(-1);
  });

  it('passes the stacks the plan opens and the holders handleBackupBucket keeps the bucket for', () => {
    const src = readFileSync(join(process.cwd(), 'src/destroy.js'), 'utf-8');
    const at = src.indexOf('checkS3CredentialMismatch({');
    const call = src.slice(at, src.indexOf('})) {', at));
    expect(call).toContain('environment: envName,');
    expect(call).toContain('stackEnvs: plan.stackEnvs,');
    expect(call).toContain(
      'backupsHolders: destroyPreviewBucketFacts(projectConfig, envName).backupBucketHolders,',
    );
    expect(call).toContain(
      'backupsPrefix: envBackupPrefixFor(projectConfig.projectName, envName),',
    );
    // After the plan it reads, and before any step of it runs.
    const planAt = src.indexOf(
      'const plan = planDestroyTargets(envConfig, projectConfig, envName);',
    );
    expect(planAt).toBeGreaterThan(-1);
    expect(planAt).toBeLessThan(at);
    expect(
      src.indexOf('await runPlan(planDestroy(plan.tier), ctx, DESTROY_EFFECTS);'),
    ).toBeGreaterThan(at);
  });
});
