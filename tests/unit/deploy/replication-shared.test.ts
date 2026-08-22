/**
 * Finding #2: shared replication primitives (src/lib/deploy/replication.js).
 *
 * These are the transport-agnostic pieces the compose deploy, k8s deploy,
 * failover, and restore paths now all consume instead of forking:
 *   - buildStagedBasebackupScript — the hardened staged-basebackup+atomic-swap
 *     bash script (probe-first optional),
 *   - verifyStreaming — the pg_stat_replication streaming poller.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertReplicationStreamingOrDegraded,
  buildNodePgdataSwapScript,
  buildPgdataSwapPodManifest,
  buildPrimaryConninfo,
  buildReplicationHbaLine,
  buildReplicationHbaLines,
  buildStagedBasebackupScript,
  PGDATA_SWAP_POD,
  parsePgdataClaimFromPodJson,
  swapPgdataViaHelperPod,
  verifyStreaming,
} from '../../../src/lib/deploy/replication.js';

// buildReplicationFirewallRules coverage lives solely in
// replication-firewall-rules.test.ts (add/no-op/drop-stale/replace-stale-peer)
// — kept here previously as a duplicate subset; consolidated to avoid two
// authoritative locations for the same pure function.

describe('buildPrimaryConninfo (plaintext over WireGuard)', () => {
  it('targets the gateway host with sslmode=disable and no sslrootcert', () => {
    const c = buildPrimaryConninfo({ primaryHost: '10.99.0.1', replPassword: 'pw' });
    expect(c).toContain('host=10.99.0.1');
    expect(c).toContain('sslmode=disable');
    expect(c).not.toContain('sslrootcert');
    expect(c).not.toContain('verify-ca');
    expect(c).toContain('application_name=standby');
  });
});
describe('buildReplicationHbaLine (plain host on tunnel subnet)', () => {
  it('emits a plain host line (not hostssl) scoped to the tunnel subnet with scram', () => {
    const line = buildReplicationHbaLine('10.99.0.0/30');
    expect(line).toBe('host replication replicator 10.99.0.0/30 scram-sha-256');
    expect(line).not.toContain('hostssl');
  });
});

describe('buildReplicationHbaLines (multi-CIDR: WG subnet + post-NAT relay source)', () => {
  it('emits one plain-host scram line per CIDR, in order', () => {
    // The relayed connection is NAT'd, so postgres sees the CNI/bridge gateway
    // as the source (live RCA 2026-07-06: FATAL no pg_hba.conf entry from
    // "10.42.2.1") — the WG /30 alone can never match it.
    const lines = buildReplicationHbaLines(['10.99.0.0/30', '10.42.0.0/16']);
    expect(lines).toEqual([
      'host replication replicator 10.99.0.0/30 scram-sha-256',
      'host replication replicator 10.42.0.0/16 scram-sha-256',
    ]);
    for (const l of lines) {
      expect(l).not.toContain('hostssl');
      expect(l).toContain('scram-sha-256');
    }
  });

  it('returns an empty list for an empty input (pure)', () => {
    expect(buildReplicationHbaLines([])).toEqual([]);
  });
});

describe('buildStagedBasebackupScript', () => {
  it('emits the hardening the failover/restore + deploy re-seed all depend on', () => {
    const script = buildStagedBasebackupScript({
      replPassword: 'pw',
      primaryHost: '10.0.0.9',
    });
    // set -e -o pipefail so a partial basebackup aborts (no half-wiped PGDATA).
    expect(script).toMatch(/set -e -o pipefail/);
    // Staged into a tmp dir, verified, then PGDATA CONTENTS replaced in place.
    expect(script).toMatch(/data\.staging/);
    // PGDATA is a volume mountpoint — must NOT be renamed (mv of a mountpoint
    // fails). Replace contents in place instead: clear + move the staged data in.
    expect(script).not.toMatch(
      /mv \/var\/lib\/postgresql\/data \/var\/lib\/postgresql\/data\.prev/,
    );
    expect(script).toMatch(/find \/var\/lib\/postgresql\/data -mindepth 1 -delete/);
    expect(script).toMatch(/mv -t \/var\/lib\/postgresql\/data\//);
    // Verifies PG_VERSION before swapping in.
    expect(script).toMatch(/PG_VERSION/);
    // Password delivered via stdin (PGPASSWORD in the script), never argv.
    expect(script).toContain("PGPASSWORD='pw'");
    // The basebackup uses a TEMPORARY slot by default (no -S) so a re-seed can
    // run while an already-streaming standby's walreceiver still holds the
    // persistent slot — `-S <persistent>` there errors "slot is active for PID"
    // (live RCA compose-ha 2026-07-07).
    expect(script).not.toContain('-S vibecarbon_standby_slot');
    expect(script).not.toMatch(/-S \S/);
    // The persistent slot is still wired for POST-SWAP streaming.
    expect(script).toContain("primary_slot_name = 'vibecarbon_standby_slot'");
  });

  it('omits the pg_isready probe block by default (probe done by the caller)', () => {
    const script = buildStagedBasebackupScript({ replPassword: 'pw', primaryHost: '10.0.0.9' });
    expect(script).not.toMatch(/pg_isready/);
  });

  it('embeds a probe-first abort guard when probeFirst is set (k8s deploy seed)', () => {
    const script = buildStagedBasebackupScript({
      replPassword: 'pw',
      primaryHost: '10.0.0.9',
      probeFirst: true,
      label: 'ha-replication',
    });
    // Aborts BEFORE any destructive work when the primary is unreachable.
    // Default port is REPL_PORT (5433) — the one replication port for both modes.
    expect(script).toMatch(/pg_isready -h 10\.0\.0\.9 -p 5433/);
    expect(script).toMatch(/\[ha-replication\]/);
    // exit 0 (clean skip) precedes the rm -rf of the staging dir.
    const probeIdx = script.indexOf('exit 0');
    const wipeIdx = script.indexOf('rm -rf /var/lib/postgresql/data.staging');
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(probeIdx).toBeLessThan(wipeIdx);
  });

  it('probe retries with a real budget before concluding skip (12 × 10s default)', () => {
    // RCA 2026-07-06 e4 rig: a single-shot probe raced the just-restarted
    // primary's relay path and silently skipped the entire reseed.
    const script = buildStagedBasebackupScript({
      replPassword: 'pw',
      primaryHost: '10.0.1.2',
      primaryPort: '15433',
      probeFirst: true,
      label: 'ha-replication',
    });
    // The retry loop: 12 attempts, 10s apart, each failure logged.
    expect(script).toContain('seq 1 12');
    expect(script).toContain('sleep 10');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal bash ${probe_i} placeholder in the generated script
    expect(script).toContain('probe attempt ${probe_i}/12');
    // Only after the WHOLE budget lapses does it skip — message names the count.
    expect(script).toContain('not reachable from standby after 12 attempts');
    expect(script).toContain('skipping pg_basebackup');
    // Still a clean exit 0 skip (callers classify), before any staging work.
    const skipIdx = script.indexOf('exit 0');
    const stageIdx = script.indexOf('rm -rf /var/lib/postgresql/data.staging');
    expect(skipIdx).toBeGreaterThanOrEqual(0);
    expect(skipIdx).toBeLessThan(stageIdx);
  });

  it('honors per-caller probeAttempts/probeDelayS overrides', () => {
    const script = buildStagedBasebackupScript({
      replPassword: 'pw',
      primaryHost: 'h',
      probeFirst: true,
      probeAttempts: 3,
      probeDelayS: 2,
    });
    expect(script).toContain('seq 1 3');
    expect(script).toContain('sleep 2');
    expect(script).toContain('after 3 attempts');
  });

  it('slotName controls only the post-swap streaming slot, not the basebackup -S', () => {
    const script = buildStagedBasebackupScript({
      replPassword: 'pw',
      primaryHost: 'h',
      primaryPort: '5433',
      slotName: 'my_slot',
    });
    expect(script).toContain('-p 5433');
    // slotName → primary_slot_name (post-swap streaming), NOT the basebackup slot.
    expect(script).toContain("primary_slot_name = 'my_slot'");
    expect(script).not.toContain('-S my_slot');
    expect(script).not.toMatch(/-S \S/); // temp slot by default: no -S at all
  });

  it('basebackupSlot (opt-in) restores an explicit -S on the basebackup', () => {
    // The default is temp-slot; a caller can still force the backup to attach to
    // a named slot when it truly needs the backup to advance that slot.
    const script = buildStagedBasebackupScript({
      replPassword: 'pw',
      primaryHost: 'h',
      basebackupSlot: 'vibecarbon_standby_slot',
    });
    expect(script).toContain('-S vibecarbon_standby_slot');
  });

  it('forces hot_standby=on in the staged auto.conf (image wal-g.conf ships it off)', () => {
    // Live RCA 2026-07-06 e4 rig: the standby STREAMED fine but refused
    // read-only connections ("FATAL: ... Hot standby mode is disabled") — the
    // supabase image's /etc/postgresql-custom/wal-g.conf sets hot_standby=off
    // and postgresql.conf leaves it commented, so the include wins unless
    // postgresql.auto.conf (read last) overrides it.
    // BOTH staging modes must carry the override:
    const combined = buildStagedBasebackupScript({ replPassword: 'pw', primaryHost: 'h' });
    expect(combined).toContain(
      'echo "hot_standby = on" >> /var/lib/postgresql/data.staging/postgresql.auto.conf',
    );
    const staged = buildStagedBasebackupScript({
      replPassword: 'pw',
      primaryHost: 'h',
      swap: false,
      stagingDir: '/var/lib/postgresql/data/.reseed_staging',
      primaryConninfo: 'host=h port=15433 user=replicator password=pw sslmode=disable',
    });
    expect(staged).toContain(
      'echo "hot_standby = on" >> /var/lib/postgresql/data/.reseed_staging/postgresql.auto.conf',
    );
    // Written into STAGING (survives the host-side swap), alongside the
    // conninfo — both land before the final chown.
    const hs = staged.indexOf('hot_standby = on');
    const chown = staged.indexOf(
      'chown -R postgres:postgres /var/lib/postgresql/data/.reseed_staging',
    );
    expect(hs).toBeGreaterThanOrEqual(0);
    expect(hs).toBeLessThan(chown);
    expect(staged.indexOf('primary_conninfo')).toBeLessThan(chown);
  });

  it('never emits TLS env (WireGuard is the encryption layer)', () => {
    const script = buildStagedBasebackupScript({ replPassword: 'pw', primaryHost: '10.99.0.1' });
    expect(script).not.toContain('PGSSLMODE');
    expect(script).not.toContain('PGSSLROOTCERT');
  });

  describe('swap:false (k8s-HA deploy seed — node-side swap)', () => {
    it('stages into the given subdir and OMITS the destructive in-place swap', () => {
      const script = buildStagedBasebackupScript({
        replPassword: 'pw',
        primaryHost: '10.0.1.2',
        primaryPort: '15433',
        probeFirst: true,
        swap: false,
        stagingDir: '/var/lib/postgresql/data/.reseed_staging',
        primaryConninfo: 'host=10.0.1.2 port=15433 user=replicator password=pw sslmode=disable',
        label: 'ha-replication',
      });
      // Stages into the PVC-resident subdir, verifies PG_VERSION, writes signals.
      expect(script).toContain('-D /var/lib/postgresql/data/.reseed_staging');
      expect(script).toContain('/var/lib/postgresql/data/.reseed_staging/PG_VERSION');
      expect(script).toContain('touch /var/lib/postgresql/data/.reseed_staging/standby.signal');
      // Explicit primary_conninfo folded into the STAGING dir (present at boot).
      expect(script).toContain('primary_conninfo');
      expect(script).toContain(
        'cat >> /var/lib/postgresql/data/.reseed_staging/postgresql.auto.conf',
      );
      // MUST NOT clear/rename the live PGDATA in-pod (that is the node-side step).
      expect(script).not.toMatch(/find \/var\/lib\/postgresql\/data -mindepth 1 -delete/);
      expect(script).not.toMatch(/mv -t \/var\/lib\/postgresql\/data\//);
    });

    it('still verifies PG_VERSION and keeps set -e -o pipefail hardening', () => {
      const script = buildStagedBasebackupScript({
        replPassword: 'pw',
        primaryHost: 'h',
        swap: false,
        stagingDir: '/data/.staging',
      });
      expect(script).toMatch(/set -e -o pipefail/);
      expect(script).toContain('if [ ! -f /data/.staging/PG_VERSION ]');
    });
  });
});

describe('buildNodePgdataSwapScript', () => {
  it('promotes verified staging with three same-filesystem renames + a swapped sentinel', () => {
    const s = buildNodePgdataSwapScript({
      pgdataDir: '/var/lib/rancher/k3s/storage/pvc-abc_vibecarbon_data/postgres-data',
    });
    const pgd = '/var/lib/rancher/k3s/storage/pvc-abc_vibecarbon_data/postgres-data';
    expect(s).toContain(`PGDATA='${pgd}'`);
    // Guarded on a real verified staging before any destructive move.
    expect(s).toContain('"$STAGING/PG_VERSION"');
    expect(s).toContain('"$STAGING/standby.signal"');
    expect(s).toContain('primary_conninfo');
    // Atomic rename chain: staging → .new → PGDATA, old rotated to .old.
    expect(s).toContain('mv "$STAGING" "$PGDATA.new"');
    expect(s).toContain('mv "$PGDATA" "$PGDATA.old"');
    expect(s).toContain('mv "$PGDATA.new" "$PGDATA"');
    // Bounded cleanup of the single stale prev-generation copy.
    expect(s).toContain('rm -rf "$PGDATA.old" "$PGDATA.new"');
    // Sentinels the caller keys on.
    expect(s).toContain('echo RESEED_SWAPPED');
    expect(s).toContain('echo RESEED_SKIPPED');
  });

  it('reports RESEED_SKIPPED (no swap) when staging has no PG_VERSION', () => {
    const s = buildNodePgdataSwapScript({ pgdataDir: '/d/pg' });
    // The skip branch precedes the swap so a missing basebackup is non-destructive.
    const skipIdx = s.indexOf('RESEED_SKIPPED');
    const swapIdx = s.indexOf('mv "$STAGING" "$PGDATA.new"');
    expect(skipIdx).toBeGreaterThanOrEqual(0);
    expect(skipIdx).toBeLessThan(swapIdx);
  });
});

// The k8s PGDATA swap moved from a node-side ssh (which is impossible on CSI —
// no hostPath, and the volume detaches on scale-to-zero) to a helper pod that
// mounts the same PVC. These pin that shared primitive.
const POD_JSON_FIXTURE = JSON.stringify({
  spec: {
    containers: [
      {
        name: 'supabase-db',
        image: 'supabase/postgres:15.8.1.060',
        volumeMounts: [
          {
            name: 'postgres-volume',
            mountPath: '/var/lib/postgresql/data',
            subPath: 'postgres-data',
          },
        ],
      },
    ],
    volumes: [
      {
        name: 'postgres-volume',
        persistentVolumeClaim: { claimName: 'data-supabase-supabase-db-0' },
      },
    ],
  },
});

describe('parsePgdataClaimFromPodJson', () => {
  it('extracts claimName, subPath, and the db image (works for local-path AND CSI)', () => {
    expect(parsePgdataClaimFromPodJson(POD_JSON_FIXTURE)).toEqual({
      claimName: 'data-supabase-supabase-db-0',
      subPath: 'postgres-data',
      image: 'supabase/postgres:15.8.1.060',
    });
  });

  it('accepts a pre-parsed object too', () => {
    const obj = JSON.parse(POD_JSON_FIXTURE);
    expect(parsePgdataClaimFromPodJson(obj).claimName).toBe('data-supabase-supabase-db-0');
  });

  it('throws when no PVC is mounted at /var/lib/postgresql/data', () => {
    const noPvc = JSON.stringify({
      spec: { containers: [{ name: 'supabase-db', image: 'x', volumeMounts: [] }], volumes: [] },
    });
    expect(() => parsePgdataClaimFromPodJson(noPvc)).toThrow(/no persistentVolumeClaim/);
  });

  it('throws when the db container image is missing (no swap-pod image to reuse)', () => {
    const noImage = JSON.stringify({
      spec: {
        containers: [
          {
            name: 'supabase-db',
            volumeMounts: [{ name: 'v', mountPath: '/var/lib/postgresql/data' }],
          },
        ],
        volumes: [{ name: 'v', persistentVolumeClaim: { claimName: 'c' } }],
      },
    });
    expect(() => parsePgdataClaimFromPodJson(noImage)).toThrow(/image/);
  });
});

describe('buildPgdataSwapPodManifest', () => {
  const manifest = JSON.parse(
    buildPgdataSwapPodManifest({
      claimName: 'data-supabase-supabase-db-0',
      image: 'supabase/postgres:15.8.1.060',
      swapScript: buildNodePgdataSwapScript({ pgdataDir: '/pgdata-vol/postgres-data' }),
    }),
  );

  it('mounts the SAME PVC (no subPath) so the swap can rename PGDATA aside', () => {
    const c = manifest.spec.containers[0];
    expect(manifest.spec.volumes[0].persistentVolumeClaim.claimName).toBe(
      'data-supabase-supabase-db-0',
    );
    // Whole volume mounted at the root; NO subPath (PGDATA is a subdir under it).
    expect(c.volumeMounts[0].mountPath).toBe('/pgdata-vol');
    expect(c.volumeMounts[0].subPath).toBeUndefined();
  });

  it('reuses the db image (already pulled on the node) and runs the swap script via bash', () => {
    const c = manifest.spec.containers[0];
    expect(c.image).toBe('supabase/postgres:15.8.1.060');
    expect(c.command[0]).toBe('bash');
    expect(c.command[1]).toBe('-c');
    expect(c.command[2]).toContain("PGDATA='/pgdata-vol/postgres-data'");
  });

  it('is a one-shot pod (restartPolicy Never) that runs as root for the renames', () => {
    expect(manifest.metadata.name).toBe(PGDATA_SWAP_POD);
    expect(manifest.spec.restartPolicy).toBe('Never');
    expect(manifest.spec.securityContext.runAsUser).toBe(0);
  });

  it('tolerates dedicated=supabase:NoSchedule (local-path PV pins the pod to the tainted node)', () => {
    // Live-hit 2026-07-07: without this the swap pod sat Unschedulable —
    // "1 node(s) had untolerated taint {dedicated: supabase}, 2 node(s) had
    // volume node affinity conflict". Harmless on CSI rigs (tolerations only
    // widen schedulability).
    expect(manifest.spec.tolerations).toEqual([
      { key: 'dedicated', operator: 'Equal', value: 'supabase', effect: 'NoSchedule' },
    ]);
  });

  it('pins to the dedicated supabase node like the db StatefulSet (CSI topology is only zonal)', () => {
    // RCA 2026-07-16 (gate run 29504041478): a detached csi.hetzner.cloud
    // volume does not attract the pod to the node it detached from, so the
    // scheduler placed the swap pod on a worker that never ran the db — the
    // cold multi-GB wal-g image pull blew the 180s swap budget. The selector
    // makes placement deterministic: cached image + node-local re-attach.
    expect(manifest.spec.nodeSelector).toEqual({ dedicated: 'supabase' });
  });
});

describe('swapPgdataViaHelperPod', () => {
  it('defaults the poll budget to 300s (restore-path CSI detach+attach ran a 180s budget to within seconds — gate run 29514516887)', () => {
    const src = readFileSync(join(__dirname, '../../../src/lib/deploy/replication.js'), 'utf-8');
    expect(src).toMatch(/budgetMs = 300_000,/);
  });

  // The status poll uses `get pod ... -o json` + JS parsing — NOT a jsonpath
  // with |/?() metachars, which the joined-argv ssh transport turns into a
  // remote bash syntax error (live-hit 2026-07-07).
  function mkKubectl(
    behavior: {
      phase?: string;
      logs?: string;
      conditions?: Array<{ type: string; reason?: string; message?: string }>;
    } = {},
  ) {
    const calls: { argv: string[]; input?: string }[] = [];
    const kubectl = vi.fn(async (argv: string[], opts: { input?: string } = {}) => {
      calls.push({ argv, input: opts?.input });
      const cmd = argv.join(' ');
      if (cmd.includes('get pod') && cmd.includes('-o json')) {
        return JSON.stringify({
          status: { phase: behavior.phase ?? 'Succeeded', conditions: behavior.conditions ?? [] },
        });
      }
      if (cmd.startsWith('logs ')) return behavior.logs ?? 'RESEED_SWAPPED';
      return '';
    });
    return { kubectl, calls };
  }

  const inputs = {
    claimName: 'data-supabase-supabase-db-0',
    subPath: 'postgres-data',
    image: 'supabase/postgres:15.8.1.060',
  };

  it('applies the swap pod, waits for Succeeded, returns its logs, and deletes it', async () => {
    const { kubectl, calls } = mkKubectl();
    const logs = await swapPgdataViaHelperPod(kubectl, inputs);
    expect(logs).toContain('RESEED_SWAPPED');

    const cmds = calls.map((c) => c.argv.join(' '));
    // Manifest carries the PVC, the reused image, and PGDATA=<root>/<subPath>.
    const apply = calls.find((c) => c.argv.join(' ').includes('apply -f -'));
    expect(apply?.input).toContain('data-supabase-supabase-db-0');
    expect(apply?.input).toContain('supabase/postgres:15.8.1.060');
    expect(apply?.input).toContain("PGDATA='/pgdata-vol/postgres-data'");
    // Waited on the pod status via shell-safe `-o json` (no jsonpath metachars
    // that the joined-argv ssh transport would hand to bash), then always
    // deleted the one-shot pod.
    const statusPolls = cmds.filter(
      (c) => c.includes('get pod vibecarbon-pgdata-swap') && c.includes('-o json'),
    );
    expect(statusPolls.length).toBeGreaterThan(0);
    for (const c of statusPolls) {
      expect(c).not.toContain('jsonpath');
      expect(c).not.toMatch(/[|?()]/);
    }
    expect(cmds.some((c) => c.includes('delete pod vibecarbon-pgdata-swap'))).toBe(true);
  });

  it('captures the pod logs into the error and still deletes the pod when it Fails', async () => {
    const { kubectl, calls } = mkKubectl({
      phase: 'Failed',
      logs: 'staging missing standby.signal',
    });
    await expect(swapPgdataViaHelperPod(kubectl, inputs)).rejects.toThrow(
      /did not succeed \(phase=Failed\)[\s\S]*staging missing standby\.signal/,
    );
    // The pod is still cleaned up on failure (finally).
    expect(calls.map((c) => c.argv.join(' ')).some((c) => c.includes('delete pod'))).toBe(true);
  });

  it('folds the pod state and events into a poll timeout (forensics before the finally-delete)', async () => {
    // RCA 2026-07-16 (gate run 29504041478): a bare "Timed out after
    // 180000ms" left zero forensic state — the finally-delete had already
    // destroyed the pod. On timeout the error must now carry the pod's
    // phase/node/waiting-reason and its events.
    const { kubectl, calls } = mkKubectl({ phase: 'Pending' });
    await expect(swapPgdataViaHelperPod(kubectl, { ...inputs, budgetMs: 10 })).rejects.toThrow(
      /Timed out[\s\S]*swap pod state at timeout[\s\S]*phase=Pending[\s\S]*swap pod events/,
    );
    const cmds = calls.map((c) => c.argv.join(' '));
    // Forensics queried the pod's scoped events…
    expect(cmds.some((c) => c.includes('get events') && c.includes('involvedObject.name='))).toBe(
      true,
    );
    // …and the pod is STILL cleaned up afterwards (finally).
    expect(cmds.some((c) => c.includes('delete pod vibecarbon-pgdata-swap'))).toBe(true);
  });

  it('fails FAST on Unschedulable (terminal — waiting cannot fix a taint/affinity conflict)', async () => {
    const schedMsg =
      '0/3 nodes are available: 1 node(s) had untolerated taint {dedicated: supabase}, ' +
      '2 node(s) had volume node affinity conflict.';
    const { kubectl, calls } = mkKubectl({
      phase: 'Pending',
      conditions: [{ type: 'PodScheduled', reason: 'Unschedulable', message: schedMsg }],
    });
    // The error names the exact scheduler conflict (not a generic timeout) and
    // surfaces on the FIRST poll — no budget wait.
    await expect(swapPgdataViaHelperPod(kubectl, inputs)).rejects.toThrow(
      /could not be scheduled[\s\S]*untolerated taint \{dedicated: supabase\}/,
    );
    // The pod is still cleaned up (finally).
    expect(calls.map((c) => c.argv.join(' ')).some((c) => c.includes('delete pod'))).toBe(true);
  });
});

describe('verifyStreaming', () => {
  const noSleep = vi.fn().mockResolvedValue(undefined);

  it('returns streaming:true as soon as readState reports "streaming"', async () => {
    const readState = vi
      .fn()
      .mockResolvedValueOnce('startup')
      .mockResolvedValueOnce('catchup')
      .mockResolvedValueOnce('streaming');
    const result = await verifyStreaming({ readState, attempts: 5, sleep: noSleep });
    expect(result).toEqual({ streaming: true, lastState: 'streaming' });
    expect(readState).toHaveBeenCalledTimes(3);
  });

  it('returns streaming:false with the last observed state after the budget lapses', async () => {
    const readState = vi.fn().mockResolvedValue('catchup');
    const result = await verifyStreaming({ readState, attempts: 3, sleep: noSleep });
    expect(result).toEqual({ streaming: false, lastState: 'catchup' });
    expect(readState).toHaveBeenCalledTimes(3);
  });

  it('reports lastState "" when no replica is ever connected', async () => {
    const readState = vi.fn().mockResolvedValue('');
    const result = await verifyStreaming({ readState, attempts: 2, sleep: noSleep });
    expect(result).toEqual({ streaming: false, lastState: '' });
  });

  it('swallows readState errors and keeps polling', async () => {
    const readState = vi
      .fn()
      .mockRejectedValueOnce(new Error('cold socket'))
      .mockResolvedValueOnce('streaming');
    const result = await verifyStreaming({ readState, attempts: 4, sleep: noSleep });
    expect(result.streaming).toBe(true);
  });

  it('reports "unreadable" (not a bare not-streaming) when every read throws', async () => {
    // e.g. the primary is unreachable for the whole window — the abort message
    // must not present the connectivity failure as "standby not streaming".
    const readState = vi.fn().mockRejectedValue(new Error('banner exchange: timed out'));
    const result = await verifyStreaming({ readState, attempts: 3, sleep: noSleep });
    expect(result.streaming).toBe(false);
    expect(result.lastState).toMatch(/unreadable/);
    // The budget-exhausted report names the actual last read failure.
    expect(result.lastState).toContain('banner exchange: timed out');
  });

  it('a transient exec failure mid-poll is NEVER terminal — keeps polling to streaming', async () => {
    // RCA 2026-07-06 e4 rig: kubectl exec against a just-recreated primary pod
    // failed once ("command terminated with exit code 1") and the old closure
    // swallowed it into a terminal verify state.
    const readState = vi
      .fn()
      .mockRejectedValueOnce(new Error('command terminated with exit code 1'))
      .mockRejectedValueOnce(new Error('command terminated with exit code 1'))
      .mockResolvedValueOnce('catchup')
      .mockResolvedValueOnce('streaming');
    const result = await verifyStreaming({ readState, attempts: 6, sleep: noSleep });
    expect(result).toEqual({ streaming: true, lastState: 'streaming' });
    expect(readState).toHaveBeenCalledTimes(4);
  });
});

// Finding #1 — the hard-gate policy shared by compose-HA + k8s-HA deploy paths.
describe('assertReplicationStreamingOrDegraded (finding #1 gate)', () => {
  it('returns { degraded: false } and does NOT throw when streaming', () => {
    expect(assertReplicationStreamingOrDegraded({ streaming: true, allowDegraded: false })).toEqual(
      { degraded: false },
    );
  });

  it('THROWS (aborts the deploy) when not streaming and allowDegraded is false', () => {
    expect(() =>
      assertReplicationStreamingOrDegraded({
        streaming: false,
        lastState: 'catchup',
        allowDegraded: false,
      }),
    ).toThrow(/HA deploy aborted/);
  });

  it('the abort error names the observed state and the -allow-degraded escape hatch', () => {
    let msg = '';
    try {
      assertReplicationStreamingOrDegraded({
        streaming: false,
        lastState: 'catchup',
        allowDegraded: false,
        fixHint: 'Check port 5433.',
      });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('catchup'); // last observed state
    expect(msg).toContain('-allow-degraded'); // how to proceed with warm standby
    expect(msg).toContain('Check port 5433.'); // mode-specific hint threaded through
  });

  it('describes "no replica connected" when lastState is empty', () => {
    expect(() =>
      assertReplicationStreamingOrDegraded({
        streaming: false,
        lastState: '',
        allowDegraded: false,
      }),
    ).toThrow(/no replica connected/);
  });

  it('warns-and-continues (returns degraded:true, does NOT throw) when allowDegraded is true', () => {
    const result = assertReplicationStreamingOrDegraded({
      streaming: false,
      lastState: 'catchup',
      allowDegraded: true,
    });
    expect(result.degraded).toBe(true);
    expect(result.reason).toMatch(/not streaming/);
  });
});
