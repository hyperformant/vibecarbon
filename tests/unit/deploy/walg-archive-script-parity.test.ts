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
// itself: supabase.values.yaml mounts the script with `subPath: wal-archive.sh`,
// and a subPath ConfigMap mount is materialised once at container start and
// never updated in place. `kubectl apply` changes the object; the database keeps
// executing the old script until its pod is recreated. Routine `vibecarbon
// deploy` never recreated that pod, so without the step below this fix would
// reach zero existing installations.
describe('a changed wal-archive.sh actually reaches the running db pod', () => {
  const k3s = readFileSync(`${repoRoot}src/lib/deploy/k8s/k3s.js`, 'utf-8');
  const values = readFileSync(`${repoRoot}carbon/k8s/values/supabase.values.yaml`, 'utf-8');

  it('is still mounted by subPath — the premise of the freshness step', () => {
    // If this ever becomes a whole-directory mount, the kubelet updates it in
    // place and the restart step below becomes unnecessary rather than wrong.
    expect(values).toMatch(
      /mountPath: \/etc\/postgresql\/wal-archive\.sh\n\s+subPath: wal-archive\.sh/,
    );
  });

  it('hashes the shipped ConfigMap and rolls the db StatefulSet when it changes', () => {
    expect(k3s).toContain('walArchiveScriptFreshness');
    expect(k3s).toContain("join(projectDir, 'k8s/base/backup/configmap-walg.yaml')");
    expect(k3s).toContain("createHash('sha256')");
    expect(k3s).toContain('applyK3sManifests: restart supabase-db (wal-archive.sh changed)');
    // Waits for the roll, so a deploy cannot report success while the old
    // script is still the one postgres will exec.
    expect(k3s).toContain('applyK3sManifests: wait supabase-db rollout (wal-archive.sh)');
  });

  it('records the sha on the StatefulSet so the next deploy is a no-op', () => {
    expect(k3s).toContain("WAL_ARCHIVE_SHA_ANNOTATION = 'vibecarbon.dev/wal-archive-sha'");
    expect(k3s).toContain('applyK3sManifests: record wal-archive.sh sha');
  });

  it('does not roll the pod twice when the archiving-enable step already did', () => {
    // A pod this deploy just recreated is running the current ConfigMap by
    // construction; rolling again would restart the database for nothing.
    expect(k3s).toContain('let dbPodJustRolled = false');
    expect(k3s).toContain('dbPodJustRolled = true');
    expect(k3s).toContain('if (dbPodJustRolled)');
  });
});
