/**
 * Regression (finding #3, revised): the wal-g S3 prefix is a SINGLE canonical
 * path shared by reads (backup-fetch/restore/reseed) and writes (backup-push/
 * wal-push). A role-segmented prefix (`…/walg/${WALG_ROLE}`) made the standby
 * read an empty `…/walg/standby` and fail restore/reseed with "No backups
 * found" (caught by compose-ha `scale` on real Hetzner). The anti-collision
 * guarantee (a standby must NEVER WRITE into the canonical prefix) is preserved
 * by a WRITE-ONLY GUARD: the wal-g role file (walg-env.sh reads it into
 * VC_WALG_ROLE). wal-archive.sh, compose-backup.sh and the k8s backup CronJob
 * all no-op on a standby and refuse with no role.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('wal-g S3 prefix is a single canonical path (NO role segment)', () => {
  it('compose docker-compose.yml uses …/walg with no WALG_ROLE path segment', () => {
    const compose = read('carbon/docker-compose.yml');
    // Canonical prefix ends at /walg (end of line — no trailing /role). The
    // lineage folder under it is walg-env.sh's, never a role.
    expect(compose).toMatch(
      /WALG_S3_PREFIX_BASE:\s*s3:\/\/[^\n]*\/backups\/\$\{PROJECT_NAME\}\/\$\{VC_ENV:-local\}\/walg\s*$/m,
    );
    // The old role-segmented form must be gone.
    expect(compose).not.toMatch(/walg\/\$\{WALG_ROLE/);
  });

  it('k8s buildDbManifestValues builds …/walg with no /<role> segment', () => {
    const k3s = read('src/lib/deploy/k8s/k3s.js');
    expect(k3s).toMatch(/s3Config\.walgPrefix/);
    expect(k3s).not.toMatch(/\/walg\/\$\{walgRole\}/);
  });
});

describe('the write-guard signal is the role file, never a WALG_ROLE env', () => {
  it('compose docker-compose.yml sets no WALG_ROLE in the db environment', () => {
    const compose = read('carbon/docker-compose.yml');
    expect(compose).not.toMatch(/^\s*WALG_ROLE:/m);
  });

  it('the k8s db StatefulSet renders no WALG_ROLE env', () => {
    const sts = read('carbon/k8s/base/db/statefulset.yaml');
    expect(sts).not.toMatch(/- name: WALG_ROLE\b/);
    expect(sts).not.toContain('{{WALG_ROLE}}');
  });

  it('k3s.js renders no {{WALG_ROLE}}', () => {
    const k3s = read('src/lib/deploy/k8s/k3s.js');
    expect(k3s).not.toContain('WALG_ROLE: walgRole');
    expect(k3s).not.toMatch(/environment\?\.endsWith\('-standby'\)/);
  });

  it('compose-HA writes the role FILE onto each node (writeComposeWalgRole), never a .env key', () => {
    // The .env WALG_ROLE is retired (D4): the role lives in
    // /opt/<project>/.vibecarbon-role/walg-role, bound read-only into db.
    // compose-role-not-in-dotenv-census.test.ts keeps it out of .env.
    const eff = read('src/lib/deploy/effects/compose-ha.js');
    expect(eff).toMatch(/writeComposeWalgRole\(\{[^)]*role: 'primary'/);
    expect(eff).toMatch(/writeComposeWalgRole\(\{[^)]*role: 'standby'/);
  });
});

describe('write paths no-op on a standby role (never write the canonical prefix)', () => {
  const STANDBY_SKIP =
    /case "\$\{VC_WALG_ROLE:-\}" in\n\s*primary\) ;;\n\s*standby\)[\s\S]*?exit 0/;

  it('wal-archive.sh skips (exit 0) on a standby role', () => {
    const script = read('carbon/volumes/db/wal-archive.sh');
    expect(script).toMatch(STANDBY_SKIP);
    // AND keeps the pg_is_in_recovery defense-in-depth gate.
    expect(script).toMatch(/pg_is_in_recovery/);
    expect(script).toMatch(/standby\.signal/);
    // Still archives on a real primary.
    expect(script).toMatch(/wal-g wal-push/);
  });

  it('compose-backup.sh skips base backup on a standby role', () => {
    const script = read('carbon/backup/compose-backup.sh');
    expect(script).toMatch(STANDBY_SKIP);
    // Keeps the recovery guard too.
    expect(script).toMatch(/pg_is_in_recovery/);
  });

  it('k8s backup CronJob skips base backup on a standby role', () => {
    const cron = read('carbon/k8s/base/backup/cronjob.yaml');
    expect(cron).toMatch(STANDBY_SKIP);
    expect(cron).toMatch(/pg_is_in_recovery/);
  });
});
