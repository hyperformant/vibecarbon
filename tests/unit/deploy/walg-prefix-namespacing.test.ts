/**
 * Regression (finding #3, revised): the wal-g S3 prefix is a SINGLE canonical
 * path shared by reads (backup-fetch/restore/reseed) and writes (backup-push/
 * wal-push). A role-segmented prefix (`…/walg/${WALG_ROLE}`) made the standby
 * read an empty `…/walg/standby` and fail restore/reseed with "No backups
 * found" (caught by compose-ha `scale` on real Hetzner). The anti-collision
 * guarantee (a standby must NEVER WRITE into the canonical prefix) is preserved
 * by turning WALG_ROLE into a WRITE-ONLY GUARD: wal-archive.sh, compose-backup.sh
 * and the k8s backup CronJob all no-op when WALG_ROLE=standby.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('wal-g S3 prefix is a single canonical path (NO role segment)', () => {
  it('compose docker-compose.yml uses …/walg with no WALG_ROLE path segment', () => {
    const compose = read('carbon/docker-compose.yml');
    // Canonical prefix ends at /walg (end of line — no trailing /role).
    expect(compose).toMatch(
      /WALG_S3_PREFIX:\s*s3:\/\/[^\n]*\/backups\/\$\{PROJECT_NAME\}\/walg\s*$/m,
    );
    // The old role-segmented form must be gone.
    expect(compose).not.toMatch(/walg\/\$\{WALG_ROLE/);
  });

  it('k8s installSupabase builds …/walg with no /<role> segment', () => {
    const k3s = read('src/lib/deploy/k8s/k3s.js');
    expect(k3s).toMatch(/backups\/\$\{projectName \|\| 'vibecarbon'\}\/walg`/);
    expect(k3s).not.toMatch(/\/walg\/\$\{walgRole\}/);
  });
});

describe('WALG_ROLE is exposed to the db container as the write-guard signal', () => {
  it('compose docker-compose.yml sets WALG_ROLE in the db environment', () => {
    const compose = read('carbon/docker-compose.yml');
    expect(compose).toMatch(/WALG_ROLE:\s*\$\{WALG_ROLE:-primary\}/);
  });

  it('k8s supabase.values.yaml renders WALG_ROLE into the db env', () => {
    const values = read('carbon/k8s/values/supabase.values.yaml');
    // Chart >= 0.7.1 env schema: list of {name, value} entries.
    expect(values).toMatch(/- name: WALG_ROLE\s+value: "\{\{WALG_ROLE\}\}"/);
  });

  it('k3s.js renders {{WALG_ROLE}} and derives the role from the explicit `role` option', () => {
    const k3s = read('src/lib/deploy/k8s/k3s.js');
    expect(k3s).toContain('.replace(/\\{\\{WALG_ROLE\\}\\}/g, walgRole)');
    // Pilot-light (Task 4): walgRole comes from the `role` option threaded
    // through deployK3s/applyK3sManifests/installSupabase, NOT an
    // `environment` suffix sniff — Task 6 fans out role: 'primary'/'standby'.
    expect(k3s).toMatch(/walgRole\s*=\s*role\s*===\s*'standby'\s*\?\s*'standby'\s*:\s*'primary'/);
    expect(k3s).not.toMatch(/environment\?\.endsWith\('-standby'\)/);
  });

  it('compose-HA writes WALG_ROLE=primary / standby onto each node (.env merge)', () => {
    // The .env merge moved out of the deployComposeHA orchestration into the
    // compose-ha deploy effect (haMergeWalgRole) when the tier was converted to
    // the step-plan; the write-guard behavior is unchanged.
    const eff = read('src/lib/deploy/effects/compose-ha.js');
    expect(eff).toMatch(/WALG_ROLE:\s*'primary'/);
    expect(eff).toMatch(/WALG_ROLE:\s*'standby'/);
  });
});

describe('write paths no-op when WALG_ROLE=standby (never write the canonical prefix)', () => {
  it('wal-archive.sh skips (exit 0) when WALG_ROLE=standby', () => {
    const script = read('carbon/volumes/db/wal-archive.sh');
    expect(script).toMatch(/WALG_ROLE:-primary\}"\s*=\s*"standby"[\s\S]*?exit 0/);
    // AND keeps the pg_is_in_recovery defense-in-depth gate.
    expect(script).toMatch(/pg_is_in_recovery/);
    expect(script).toMatch(/standby\.signal/);
    // Still archives on a real primary.
    expect(script).toMatch(/wal-g wal-push/);
  });

  it('compose-backup.sh skips base backup when WALG_ROLE=standby', () => {
    const script = read('carbon/backup/compose-backup.sh');
    expect(script).toMatch(/WALG_ROLE:-primary\}"\s*=\s*"standby"[\s\S]*?exit 0/);
    // Keeps the recovery guard too.
    expect(script).toMatch(/pg_is_in_recovery/);
  });

  it('k8s backup CronJob skips base backup when WALG_ROLE=standby', () => {
    const cron = read('carbon/k8s/base/backup/cronjob.yaml');
    expect(cron).toMatch(/WALG_ROLE:-primary\}"\s*=\s*"standby"[\s\S]*?exit 0/);
    expect(cron).toMatch(/pg_is_in_recovery/);
  });
});
