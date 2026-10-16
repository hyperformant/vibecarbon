/**
 * The WAL-archive wrapper is ONE script deployed two ways, and this pins that.
 *
 * `carbon/volumes/db/wal-archive.sh` is bind-mounted by compose; k8s ships a
 * copy inside the `vibecarbon-wal-archive` ConfigMap. The ConfigMap has always
 * CLAIMED, in a header comment, to be "byte-for-byte in sync" with the compose
 * file. It was not. The k8s copy had lost BOTH guards the compose copy carries:
 *
 *   - the WALG_ROLE write-guard, so a k8s standby — or, worse, a standby whose
 *     first-boot seed exited UNSEEDED and is therefore briefly an INDEPENDENT
 *     primary — pushed WAL straight into the primary's single canonical
 *     WALG_S3_PREFIX. Two writers, one backup stream.
 *   - the pg_is_in_recovery() gate behind it.
 *
 * A comment cannot enforce anything, so this test does: it dedents the block
 * scalar out of the ConfigMap and compares it to the file. The failure message
 * prints the exact block to paste back, so re-syncing is mechanical.
 *
 * It also pins the ONE property both copies must never lose: every guard and
 * every exhausted-retry path exits 0. A non-zero archive_command makes postgres
 * refuse to recycle the segment, pg_wal grows without bound and the disk fills
 * (RCA prod-1 2026-05-26) — which is worse than the PITR gap it would be
 * signalling.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const COMPOSE_SCRIPT = 'carbon/volumes/db/wal-archive.sh';
const K8S_CONFIGMAP = 'carbon/k8s/base/backup/configmap-walg.yaml';

const composeBody = readFileSync(`${repoRoot}${COMPOSE_SCRIPT}`, 'utf-8');
const configMapRaw = readFileSync(`${repoRoot}${K8S_CONFIGMAP}`, 'utf-8');
const configMap = loadYaml(configMapRaw) as { data: Record<string, string> };
const k8sBody = configMap.data['wal-archive.sh'];

describe('wal-archive.sh is byte-identical across compose and k8s', () => {
  it('the ConfigMap block scalar dedents to exactly the compose script', () => {
    if (k8sBody !== composeBody) {
      const paste = composeBody
        .split('\n')
        .map((l) => (l.length ? `    ${l}` : l))
        .join('\n');
      throw new Error(
        `${K8S_CONFIGMAP} has drifted from ${COMPOSE_SCRIPT}. They must stay identical — ` +
          `the k8s copy silently losing the WALG_ROLE write-guard is exactly how a standby ` +
          `ended up archiving into the primary's WAL stream. Replace everything under ` +
          `\`wal-archive.sh: |\` with:\n\n${paste}`,
      );
    }
    expect(k8sBody).toBe(composeBody);
  });

  it('both tiers therefore carry the WALG_ROLE write-guard', () => {
    // The bring-up guard: a standby db can briefly be an independent primary
    // (not yet in recovery) before it is reseeded, which the recovery gate
    // below cannot catch. This is the only thing that closes that window.
    for (const [name, body] of [
      [COMPOSE_SCRIPT, composeBody],
      [K8S_CONFIGMAP, k8sBody],
    ] as const) {
      expect(body, name).toMatch(/if \[ "\$\{WALG_ROLE:-primary\}" = "standby" \]; then/);
      expect(body, name).toMatch(/WALG_ROLE=standby[\s\S]*?exit 0/);
    }
  });

  it('both tiers therefore carry the pg_is_in_recovery() gate', () => {
    for (const [name, body] of [
      [COMPOSE_SCRIPT, composeBody],
      [K8S_CONFIGMAP, k8sBody],
    ] as const) {
      expect(body, name).toContain('SELECT pg_is_in_recovery()');
      // Fallback for when psql cannot answer from the archive_command context.
      expect(body, name).toContain('standby.signal');
      // Only SKIP on POSITIVE confirmation of recovery — an unknown answer must
      // never drop a real primary's WAL.
      expect(body, name).toMatch(/if \[ "\$in_recovery" = "t" \]; then/);
    }
  });

  it('every exit in the shared script is exit 0 — a non-zero archive_command fills the disk', () => {
    const exits = composeBody.match(/^\s*exit \d+/gm) ?? [];
    expect(exits.length).toBeGreaterThanOrEqual(4); // role guard, recovery gate, push success, exhausted
    for (const e of exits) expect(e.trim()).toBe('exit 0');
    // Including the one that runs after all retries are exhausted, which is the
    // whole reason this wrapper exists rather than a bare `wal-g wal-push %p`.
    expect(composeBody).toMatch(/WAL_ARCHIVE_FAILED[\s\S]*\nexit 0\n?$/);
  });

  it('the ConfigMap header no longer merely ASKS for sync — it names the pin', () => {
    // The old header said "IMPORTANT: keep this script body byte-for-byte in
    // sync" and nothing enforced it. If someone deletes the pin, this fails.
    const header = configMapRaw.slice(0, configMapRaw.indexOf('apiVersion:'));
    expect(header).toContain('walg-archive-script-parity');
  });
});

// Restoring parity in the ConfigMap achieves NOTHING on an existing cluster by
// itself: the db StatefulSet mounts the script with `subPath: wal-archive.sh`,
// and a subPath ConfigMap mount is materialised once at container start and
// never updated in place. `kubectl apply` changes the object; the database keeps
// executing the old script until its pod is recreated. So the pod template
// carries the ConfigMap's sha: a changed script changes the template, and the
// same apply rolls the pod (inside the db rollout wait).
describe('a changed wal-archive.sh actually reaches the running db pod', () => {
  const k3s = readFileSync(`${repoRoot}src/lib/deploy/k8s/k3s.js`, 'utf-8');
  const sts = readFileSync(`${repoRoot}carbon/k8s/base/db/statefulset.yaml`, 'utf-8');

  it('is still mounted by subPath — the premise of the sha annotation', () => {
    // If this ever becomes a whole-directory mount, the kubelet updates it in
    // place and the annotation becomes unnecessary rather than wrong.
    expect(sts).toMatch(
      /mountPath: \/etc\/postgresql\/wal-archive\.sh\n\s+subPath: wal-archive\.sh/,
    );
  });

  it('stamps the ConfigMap sha into the POD TEMPLATE, so a change rolls the pod', () => {
    const template = sts.slice(sts.indexOf('  template:'), sts.indexOf('    spec:'));
    expect(template).toContain('vibecarbon.dev/wal-archive-sha: "{{WAL_ARCHIVE_SHA}}"');
  });

  it('hashes the shipped ConfigMap file and renders it into the StatefulSet', () => {
    expect(k3s).toContain("join(projectDir, 'k8s/base/backup/configmap-walg.yaml')");
    expect(k3s).toContain("createHash('sha256')");
    expect(k3s).toContain('walArchiveSha: walArchiveConfigSha(projectDir)');
    expect(k3s).toContain("WAL_ARCHIVE_SHA: walArchiveSha || 'none'");
  });
});

// Final review M2: with no backup target (local dev's empty WALG_S3_PREFIX,
// or a bucketless `s3:///...` render) every segment waited out the wal-g
// attempts and logged WAL_ARCHIVE_FAILED. The script now exits 0 before any
// wal-g call, like backup/compose-backup.sh. Runs the real script with bash.
describe('wal-archive.sh with no backup target', () => {
  const run = (prefix: string) =>
    spawnSync('bash', [`${repoRoot}${COMPOSE_SCRIPT}`, 'pg_wal/000000010000000000000001'], {
      encoding: 'utf-8',
      env: {
        PATH: process.env.PATH,
        WALG_S3_PREFIX: prefix,
        WAL_ARCHIVE_RETRIES: '1',
        WAL_ARCHIVE_SLEEP: '0',
        PGDATA: '/nonexistent',
      },
      timeout: 10_000,
    });

  for (const prefix of ['', 's3:///backups/acme']) {
    it(`"${prefix}" exits 0 at once with one line, never reaching wal-g`, () => {
      const r = run(prefix);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('wal-archive: no backup target');
      expect(r.stderr).not.toContain('WAL_ARCHIVE_FAILED');
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
    });
  }

  it('a real target still goes through the wal-g attempts (control)', () => {
    const r = run('s3://bucket/backups/acme');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('no backup target');
    expect(r.stderr).toContain('WAL_ARCHIVE_FAILED');
  });

  it('the guard sits before the wal-g retry loop in both copies', () => {
    for (const body of [composeBody, k8sBody]) {
      expect(body.indexOf('""|s3:///*)')).toBeGreaterThan(-1);
      expect(body.indexOf('""|s3:///*)')).toBeLessThan(body.indexOf('wal-g wal-push "$WAL_PATH"'));
    }
  });
});
