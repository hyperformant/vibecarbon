/**
 * Finding #2: shared replication primitives (src/lib/deploy/replication.js).
 *
 * These are the transport-agnostic pieces the compose deploy, k8s deploy,
 * failover, and restore paths now all consume instead of forking:
 *   - buildStagedBasebackupScript — the hardened staged-basebackup+atomic-swap
 *     bash script (probe-first optional),
 *   - verifyStreaming — the pg_stat_replication streaming poller.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertReplicationStreamingOrDegraded,
  buildNodePgdataSwapScript,
  buildPrimaryConninfo,
  buildReplicationHbaLine,
  buildReplicationHbaLines,
  buildStagedBasebackupScript,
  IN_PLACE_RESEED_DIR,
  reseedDisarmArgv,
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

  it('pins hot_standby=on in the staged auto.conf, whatever the image config says', () => {
    // With hot_standby off, a reseeded standby streams fine but refuses
    // read-only connections ("FATAL: ... Hot standby mode is disabled"), so
    // every pg_is_in_recovery() check fails (live RCA 2026-07-06 e4 rig, when
    // an image config include shipped it off). postgresql.auto.conf is read
    // last, so the staged line wins over any image or include setting.
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

describe('buildStagedBasebackupScript in-place mode', () => {
  const base = {
    replPassword: 'p',
    primaryHost: '10.0.0.5',
    primaryPort: '15433',
    swap: false,
    stagingDir: IN_PLACE_RESEED_DIR,
    primaryConninfo: 'host=10.0.0.5',
    inPlaceAttempt: 'att-1',
    intent: 'standby',
  };
  const s = buildStagedBasebackupScript(base);
  it('clears a stale ready marker before staging anything', () => {
    expect(s.indexOf('rm -f /var/lib/postgresql/data/.vc-reseed-ready')).toBeLessThan(
      s.indexOf('pg_basebackup'),
    );
  });
  it('strips every .vc-* the primary carried, then stamps the attempt', () => {
    expect(s).toMatch(
      /find \/var\/lib\/postgresql\/data\/\.vc-reseed -mindepth 1 -maxdepth 1 -name '\.vc-\*' -exec rm -rf \{\} \+/,
    );
    expect(s.indexOf("-name '.vc-*'")).toBeLessThan(s.indexOf('.vc-reseed-id'));
  });
  it('marks ready LAST, by rename, after chown and every staging edit', () => {
    const ready = s.indexOf(
      'mv -f /var/lib/postgresql/data/.vc-reseed-ready.tmp /var/lib/postgresql/data/.vc-reseed-ready',
    );
    expect(ready).toBeGreaterThan(s.lastIndexOf('chown -R postgres:postgres'));
    expect(ready).toBeGreaterThan(s.indexOf('primary_conninfo'));
    expect(s.trim().endsWith('echo "RESEED_STAGED att-1"')).toBe(true);
  });
  it('writes the ready marker durably: tmp, sync, rename, sync', () => {
    expect(s).toMatch(
      /> \/var\/lib\/postgresql\/data\/\.vc-reseed-ready\.tmp\nsync\nmv -f \/var\/lib\/postgresql\/data\/\.vc-reseed-ready\.tmp \/var\/lib\/postgresql\/data\/\.vc-reseed-ready\nsync\n/,
    );
  });
  it('stages only for a standby intent the CLI read, never the running container env', () => {
    // The running container's VC_WALG_ROLE_INTENT is the value from ITS start:
    // after a failover swaps the roles it still names the old role until the
    // container restarts (the 2026-11-04 reconverge refusal). The intent that
    // matters is the one the NEXT start reads, the vibecarbon-db-role
    // ConfigMap's, which the CLI's guard read; db-guard.sh swaps under it.
    expect(s).not.toContain('VC_WALG_ROLE_INTENT');
    for (const intent of ['', 'primary', 'standby2', undefined]) {
      expect(() => buildStagedBasebackupScript({ ...base, intent })).toThrow(/intent/);
    }
    expect(readFileSync('carbon/volumes/db/db-guard.sh', 'utf-8')).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion text
      '[ "${VC_WALG_ROLE_INTENT:-}" = standby ]',
    );
  });
  it('holds the shared PGDATA lock (restore, db-guard) before it clears anything', () => {
    const lock = s.indexOf('exec 9>/var/lib/postgresql/data/.vc-restore.lock');
    expect(lock).toBeGreaterThan(s.indexOf('if [ -L /var/lib/postgresql/data/.vc-restore.lock ]'));
    expect(s).toContain('if ! flock -n 9; then');
    expect(lock).toBeLessThan(s.indexOf('rm -f /var/lib/postgresql/data/.vc-reseed-ready'));
    expect(lock).toBeLessThan(s.indexOf('.vc-reseed-in-progress'));
  });
  it('never stops postgres and never swaps in-pod', () => {
    expect(s).not.toMatch(/pg_ctl|kill |-mindepth 1 -delete/);
  });
  it('probeFirst: an unreachable primary prints RESEED_SKIPPED and stages nothing', () => {
    const p = buildStagedBasebackupScript({
      ...base,
      probeFirst: true,
      probeAttempts: 1,
      probeDelayS: 0,
    });
    expect(p).toMatch(/\n {2}echo RESEED_SKIPPED\n {2}exit 0\nfi/);
    expect(p.indexOf('RESEED_SKIPPED')).toBeLessThan(p.indexOf('pg_basebackup'));
  });
  it('bounds pg_basebackup with a remote deadline, only in in-place mode', () => {
    const d = buildStagedBasebackupScript({ ...base, basebackupDeadlineS: 777 });
    expect(d).toContain('( sleep 777; vc_kill_tree "$vc_bb_pid" ) >/dev/null 2>&1 9>&- &');
    expect(d).not.toMatch(/\btimeout -s/);
    expect(d).toContain('echo "RESEED_TIMEOUT 777"');
    expect(() =>
      buildStagedBasebackupScript({
        replPassword: 'p',
        primaryHost: 'h',
        swap: true,
        basebackupDeadlineS: 777,
      }),
    ).toThrow(/in-place/);
    expect(() => buildStagedBasebackupScript({ ...base, basebackupDeadlineS: 0 })).toThrow(
      /deadline/,
    );
  });

  it('refuses an attempt id the shell would read as more than a word', () => {
    expect(() => buildStagedBasebackupScript({ ...base, inPlaceAttempt: "a'; rm -rf /" })).toThrow(
      /attempt/,
    );
    expect(() => buildStagedBasebackupScript({ ...base, inPlaceAttempt: '' })).toThrow(/attempt/);
  });
  it('refuses an in-place stage anywhere but $PGDATA/.vc-reseed, or with the in-pod swap', () => {
    expect(() =>
      buildStagedBasebackupScript({
        ...base,
        stagingDir: '/var/lib/postgresql/data/.reseed_staging',
      }),
    ).toThrow(/\.vc-reseed/);
    expect(() => buildStagedBasebackupScript({ ...base, swap: true })).toThrow(/swap/);
  });
  it('callers without inPlaceAttempt are byte-identical to before', () => {
    expect(
      buildStagedBasebackupScript({ replPassword: 'p', primaryHost: 'h', swap: true }),
    ).toMatchSnapshot();
    expect(
      buildStagedBasebackupScript({
        replPassword: 'p',
        primaryHost: 'h',
        swap: false,
        stagingDir: '/var/lib/postgresql/data/.reseed_staging',
      }),
    ).toMatchSnapshot();
    expect(
      buildStagedBasebackupScript({
        replPassword: 'p',
        primaryHost: 'h',
        probeFirst: true,
        swap: false,
        stagingDir: '/var/lib/postgresql/data/.reseed_staging',
        primaryConninfo: 'host=h',
      }),
    ).toMatchSnapshot();
  });
});

/**
 * The in-place stage, executed under sh against a temp PGDATA, then the REAL
 * db-guard.sh swap on the same directory. Stubs on PATH: pg_basebackup copies
 * a fixture primary (a failed-back one, still carrying the .vc-* entries of its
 * time as a standby), pg_isready answers per STUB_ISREADY, chown is a no-op.
 * Every other external command the stage runs is wrapped so the Nth call of
 * any of them can fail (FAIL_AT=name:N): a stage cut short at that point.
 */
const hasFlock = spawnSync('sh', ['-c', 'command -v flock']).status === 0;
const GUARD = fileURLToPath(new URL('../../../carbon/volumes/db/db-guard.sh', import.meta.url));
const WRAPPED = ['rm', 'mkdir', 'touch', 'sed', 'find', 'sync', 'mv', 'cat'];

describe.skipIf(!hasFlock)('the in-place stage, executed, then the real db-guard.sh swap', () => {
  let dir: string;
  let pgdata: string;
  let bin: string;
  let guardBin: string;
  let primary: string;
  let calls: string;
  const dirs: string[] = [];

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'vc-inplace-stage-'));
    dirs.push(dir);
    pgdata = join(dir, 'data');
    bin = join(dir, 'bin');
    guardBin = join(dir, 'guard-bin');
    primary = join(dir, 'primary');
    calls = join(dir, 'calls');
    for (const d of [pgdata, bin, guardBin, primary]) mkdirSync(d);
    // The live standby cluster.
    mkdirSync(join(pgdata, 'base'));
    writeFileSync(join(pgdata, 'PG_VERSION'), '17\n');
    writeFileSync(join(pgdata, 'base', 'marker'), 'live\n');
    writeFileSync(join(pgdata, 'standby.signal'), '');
    // A failed-back primary: its .vc-* entries from its standby time, and a
    // planned-failover write fence in its auto.conf.
    mkdirSync(join(primary, 'base'));
    writeFileSync(join(primary, 'PG_VERSION'), '17\n');
    writeFileSync(join(primary, 'base', 'marker'), 'primary\n');
    writeFileSync(
      join(primary, 'postgresql.auto.conf'),
      'port = 5432\ndefault_transaction_read_only = on\n',
    );
    writeFileSync(join(primary, '.vc-reseeded-from'), 'old-attempt');
    writeFileSync(join(primary, '.vc-reseed-ready'), 'old-attempt');
    writeFileSync(join(primary, '.vc-reseed-in-progress'), 'in old-attempt');
    mkdirSync(join(primary, '.vc-discard', 'base'), { recursive: true });
    writeFileSync(join(primary, '.vc-discard', 'PG_VERSION'), '17\n');

    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    const counted = (name: string) =>
      [
        `n=$(grep -cx ${name} "$CALLS" 2>/dev/null || true)`,
        `echo ${name} >> "$CALLS"`,
        `if [ "\${FAIL_AT:-}" = "${name}:$((\${n:-0} + 1))" ]; then echo "injected failure ${name}:$((\${n:-0} + 1))" >&2; exit 1; fi`,
      ].join('\n');
    for (const name of WRAPPED) {
      const real = spawnSync('sh', ['-c', `command -v ${name}`], {
        encoding: 'utf-8',
      }).stdout.trim();
      stub(name, `${counted(name)}\nexec ${real} "$@"`);
    }
    stub('chown', `${counted('chown')}\nexit 0`);
    // busybox timeout (the db image is Alpine): signal ONLY the program it
    // execs, never its children. A deadline built on it leaves pg_basebackup's
    // forked WAL streamer writing.
    stub(
      'timeout',
      [
        'sig=TERM; if [ "$1" = -s ]; then sig=$2; shift 2; fi; n=$1; shift',
        '( sleep "$n"; kill -"$sig" $$ ) >/dev/null 2>&1 &',
        'exec "$@"',
      ].join('\n'),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion text
    stub('pg_isready', '[ "${STUB_ISREADY:-0}" = 0 ]');
    stub(
      'pg_basebackup',
      [
        counted('pg_basebackup'),
        // The stub's own commands are not the stage's: no wrappers.
        `PATH='${process.env.PATH}'`,
        'D=""; while [ $# -gt 0 ]; do [ "$1" = -D ] && D="$2"; shift; done',
        // A transfer cut off half way: part of the tree, then a failure.
        `if [ "\${BB_PARTIAL:-}" = 1 ]; then cp -a "${primary}/base" "$D/"; exit 1; fi`,
        // pg_basebackup -Xs: a forked WAL streamer that keeps writing into the
        // staging after its parent is gone; its pid goes to $BB_FORK.
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion text
        'if [ -n "${BB_FORK:-}" ]; then',
        '  ( n=0; while :; do [ -d "$D/pg_wal" ] || mkdir -p "$D/pg_wal"; : > "$D/pg_wal/seg$n"; n=$((n + 1)); sleep 0.02; done ) &',
        '  echo $! > "$BB_FORK"',
        '  while :; do sleep 0.05; done',
        'fi',
        // A slow transfer: say it started, then wait (bounded) to be let go.
        'if [ -n "$BB_GATE" ]; then',
        '  : > "$BB_GATE.started"',
        '  i=0; while [ ! -e "$BB_GATE.go" ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i + 1)); done',
        'fi',
        `cp -a "${primary}/." "$D/"`,
        'touch "$D/standby.signal"',
        `printf "primary_conninfo = 'host=10.0.0.5'\\n" >> "$D/postgresql.auto.conf"`,
      ].join('\n'),
    );
    writeFileSync(join(guardBin, 'db-entrypoint.sh'), '#!/bin/sh\necho "STUB-ENTRYPOINT $*"\n');
    chmodSync(join(guardBin, 'db-entrypoint.sh'), 0o755);
  }

  beforeEach(setup);
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const script = (extra: Record<string, unknown> = {}) =>
    buildStagedBasebackupScript({
      replPassword: 'p',
      primaryHost: '10.0.0.5',
      primaryPort: '15433',
      swap: false,
      stagingDir: IN_PLACE_RESEED_DIR,
      primaryConninfo: 'host=10.0.0.5 port=15433',
      inPlaceAttempt: 'att-1',
      intent: 'standby',
      // The production shape: reseedStandbyInPlace always bounds the transfer.
      basebackupDeadlineS: 600,
      ...extra,
    }).replaceAll('/var/lib/postgresql/data', pgdata);

  const stageEnv = (env: Record<string, string>) => ({
    PATH: `${bin}:${process.env.PATH}`,
    CALLS: calls,
    VC_WALG_ROLE_INTENT: 'standby',
    ...env,
  });
  function stage(env: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    // One file per attempt: sh reads a script as it runs, so a second stage
    // must never rewrite the file a first one is still executing.
    const file = join(dir, `stage-${String(extra.inPlaceAttempt ?? 'att-1')}.sh`);
    writeFileSync(file, script(extra));
    return spawnSync('sh', [file], { encoding: 'utf-8', env: stageEnv(env) });
  }
  function guard(intent = 'standby') {
    return spawnSync('sh', [GUARD, 'postgres'], {
      encoding: 'utf-8',
      env: {
        PATH: `${guardBin}:${process.env.PATH}`,
        PGDATA: pgdata,
        VC_WALG_ROLE_INTENT: intent,
        VC_WALG_ROLE_DIR: join(dir, 'no-role-dir'),
      },
    });
  }
  const read = (rel: string) => readFileSync(join(pgdata, rel), 'utf-8');
  const cluster = () =>
    readdirSync(pgdata)
      .filter((e) => !e.startsWith('.vc-'))
      .sort();
  const LIVE = ['PG_VERSION', 'base', 'standby.signal'];

  it('stages a tree with no .vc-* but its id, marks it ready, and the real swap takes it', () => {
    const r = stage();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n').at(-1)).toBe('RESEED_STAGED att-1');
    // The live cluster is untouched.
    expect(cluster()).toEqual(LIVE);
    expect(read('base/marker')).toBe('live\n');
    const staged = join(pgdata, '.vc-reseed');
    expect(readdirSync(staged).filter((e) => e.startsWith('.vc-'))).toEqual(['.vc-reseed-id']);
    expect(read('.vc-reseed/.vc-reseed-id')).toBe('att-1');
    expect(read('.vc-reseed-ready')).toBe('att-1');
    expect(existsSync(join(pgdata, '.vc-reseed-ready.tmp'))).toBe(false);
    const auto = read('.vc-reseed/postgresql.auto.conf');
    expect(auto).toContain("primary_conninfo = 'host=10.0.0.5 port=15433'");
    expect(auto).not.toContain('default_transaction_read_only');
    expect(existsSync(join(staged, 'standby.signal'))).toBe(true);

    const g = guard();
    expect(g.status, g.stderr).toBe(0);
    expect(g.stderr).toContain('RESEED_SWAPPED att-1');
    expect(g.stdout).toContain('STUB-ENTRYPOINT postgres');
    expect(read('base/marker')).toBe('primary\n');
    expect(read('.vc-reseeded-from')).toBe('att-1');
    expect(readFileSync(join(pgdata, '.vc-discard', 'base', 'marker'), 'utf-8')).toBe('live\n');
    for (const f of ['.vc-reseed', '.vc-reseed-ready', '.vc-reseed-in-progress']) {
      expect(existsSync(join(pgdata, f)), f).toBe(false);
    }
  });

  it('reconverge: the old primary container still says primary in its env, the stage runs and the swap takes it', () => {
    // A failover swapped the roles: the ConfigMap now says standby, the
    // running container (started as the primary) still has primary in env.
    const r = stage({ VC_WALG_ROLE_INTENT: 'primary' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n').at(-1)).toBe('RESEED_STAGED att-1');
    // The restarted container resolves the ConfigMap again: standby.
    const g = guard('standby');
    expect(g.status, g.stderr).toBe(0);
    expect(g.stderr).toContain('RESEED_SWAPPED att-1');
  });

  it('a restarted container whose intent is still not standby never swaps the staged tree', () => {
    expect(stage().status).toBe(0);
    const g = guard('primary');
    expect(g.stderr).not.toContain('RESEED_SWAPPED');
    expect(read('base/marker')).toBe('live\n');
  });

  it('a swap under way (.vc-reseed-in-progress): refuses, nothing touched', () => {
    mkdirSync(join(pgdata, '.vc-reseed'));
    writeFileSync(join(pgdata, '.vc-reseed', 'PG_VERSION'), '17\n');
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), 'out x');
    writeFileSync(join(pgdata, '.vc-reseed-ready'), 'x');
    const r = stage();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/in progress/);
    expect(read('.vc-reseed/PG_VERSION')).toBe('17\n');
    expect(read('.vc-reseed-ready')).toBe('x');
  });

  it('a stray .vc-reseed with no marker is cleared, even when the probe skips', () => {
    mkdirSync(join(pgdata, '.vc-reseed', 'base'), { recursive: true });
    writeFileSync(join(pgdata, '.vc-reseed', 'PG_VERSION'), '17\n');
    const r = stage({ STUB_ISREADY: '1' }, { probeFirst: true, probeAttempts: 1, probeDelayS: 0 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('RESEED_SKIPPED');
    expect(existsSync(join(pgdata, '.vc-reseed'))).toBe(false);
    expect(existsSync(join(pgdata, '.vc-reseed-ready'))).toBe(false);
    expect(cluster()).toEqual(LIVE);
  });

  it('two stages at once: exactly one stages, the other refuses busy and touches nothing', async () => {
    const gate = join(dir, 'gate');
    const fileA = join(dir, 'stage-A.sh');
    writeFileSync(fileA, script());
    const a = spawn('sh', [fileA], { env: stageEnv({ BB_GATE: gate }) });
    let outA = '';
    a.stdout.on('data', (d) => {
      outA += d;
    });
    const exitA = new Promise<number | null>((res) => a.on('close', res));
    try {
      // Bounded wait for A to be inside its transfer, holding the lock.
      for (let i = 0; i < 200 && !existsSync(`${gate}.started`); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(`${gate}.started`), 'stage A never reached its transfer').toBe(true);
      const b = stage({}, { inPlaceAttempt: 'att-2' });
      expect(b.status).toBe(1);
      expect(b.stdout.trim()).toBe('RESEED_REFUSED busy');
      expect(existsSync(join(pgdata, '.vc-reseed', '.vc-reseed-id'))).toBe(false);
      expect(existsSync(join(pgdata, '.vc-reseed-ready'))).toBe(false);
    } finally {
      writeFileSync(`${gate}.go`, '');
    }
    expect(await exitA).toBe(0);
    expect(outA.trim().split('\n').at(-1)).toBe('RESEED_STAGED att-1');
    expect(read('.vc-reseed-ready')).toBe('att-1');
    expect(read('.vc-reseed/.vc-reseed-id')).toBe('att-1');
  });

  it('a transfer past its remote deadline is killed: RESEED_TIMEOUT, nothing armed, the lock free', () => {
    // A gate never opened: the stub transfer waits until it is killed.
    const r = stage({ BB_GATE: join(dir, 'never') }, { basebackupDeadlineS: 1 });
    expect(r.status).toBe(1);
    expect(r.stdout.trim().split('\n').at(-1)).toBe('RESEED_TIMEOUT 1');
    expect(r.stderr).toMatch(/did not finish within 1s/);
    expect(existsSync(join(pgdata, '.vc-reseed'))).toBe(false);
    expect(existsSync(join(pgdata, '.vc-reseed-ready'))).toBe(false);
    expect(cluster()).toEqual(LIVE);
    const g = guard();
    expect(g.status, g.stderr).toBe(0);
    expect(g.stderr).not.toContain('RESEED_SWAPPED');
    // The lock went with the killed transfer: the next stage is not busy.
    rmSync(calls);
    const next = stage({}, { inPlaceAttempt: 'att-2' });
    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout.trim().split('\n').at(-1)).toBe('RESEED_STAGED att-2');
  });

  it("a timed-out transfer's forked WAL streamer dies with it: RESEED_TIMEOUT, nothing armed, nothing left writing", () => {
    const pidFile = join(dir, 'streamer.pid');
    const r = stage({ BB_FORK: pidFile }, { basebackupDeadlineS: 1 });
    expect(r.status).toBe(1);
    expect(r.stdout.trim().split('\n').at(-1)).toBe('RESEED_TIMEOUT 1');
    expect(r.stderr).toMatch(/did not finish within 1s/);
    expect(existsSync(join(pgdata, '.vc-reseed-ready'))).toBe(false);
    const pid = Number(readFileSync(pidFile, 'utf-8').trim());
    expect(pid).toBeGreaterThan(0);
    // The streamer is gone, not reparented and still writing.
    expect(spawnSync('kill', ['-0', String(pid)]).status).not.toBe(0);
    expect(existsSync(join(pgdata, '.vc-reseed'))).toBe(false);
    const g = guard();
    expect(g.stderr).not.toContain('RESEED_SWAPPED');
    expect(read('base/marker')).toBe('live\n');
  });

  it('a transfer that fails fast is a plain failure, never a timeout', () => {
    const r = stage({ BB_PARTIAL: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('RESEED_TIMEOUT');
    expect(existsSync(join(pgdata, '.vc-reseed'))).toBe(false);
  });

  const disarm = (attempt: string, env: Record<string, string> = {}) =>
    spawnSync(
      'sh',
      ['-c', reseedDisarmArgv(attempt)[2].replaceAll('/var/lib/postgresql/data', pgdata)],
      {
        encoding: 'utf-8',
        env: stageEnv(env),
      },
    );

  it("the disarm clears this attempt's armed tree under the lock; the swap then takes nothing", () => {
    expect(stage().status).toBe(0);
    const d = disarm('att-1');
    expect(d.status, d.stderr).toBe(0);
    expect(d.stdout.trim()).toBe('RESEED_DISARMED');
    expect(existsSync(join(pgdata, '.vc-reseed-ready'))).toBe(false);
    expect(existsSync(join(pgdata, '.vc-reseed'))).toBe(false);
    const g = guard();
    expect(g.stderr).not.toContain('RESEED_SWAPPED');
    expect(read('base/marker')).toBe('live\n');
  });

  it("the disarm leaves another attempt's tree, and a swap under way, alone", () => {
    expect(stage().status).toBe(0);
    const other = disarm('att-9');
    expect(other.status).toBe(1);
    expect(other.stdout).toMatch(/^RESEED_DISARM_REFUSED /);
    expect(read('.vc-reseed-ready')).toBe('att-1');
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), 'out att-1');
    const midSwap = disarm('att-1');
    expect(midSwap.status).toBe(1);
    expect(midSwap.stdout).toMatch(/^RESEED_DISARM_REFUSED .*in progress/);
    expect(read('.vc-reseed-ready')).toBe('att-1');
  });

  it('the disarm refuses while another holds the lock, touching nothing', async () => {
    expect(stage().status).toBe(0);
    const holder = spawn('sh', [
      '-c',
      `exec 9>"${pgdata}/.vc-restore.lock"; flock 9; echo held; sleep 5`,
    ]);
    try {
      await new Promise<void>((res) => holder.stdout.once('data', () => res()));
      const d = disarm('att-1');
      expect(d.status).toBe(1);
      expect(d.stdout.trim()).toBe('RESEED_DISARM_REFUSED busy');
      expect(read('.vc-reseed-ready')).toBe('att-1');
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('a symlinked lock is refused, nothing touched', () => {
    writeFileSync(join(pgdata, '.vc-reseed-ready'), 'old');
    symlinkSync(join(dir, 'elsewhere'), join(pgdata, '.vc-restore.lock'));
    const r = stage();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/symlink/);
    expect(existsSync(join(dir, 'elsewhere'))).toBe(false);
    expect(read('.vc-reseed-ready')).toBe('old');
  });

  it('a stale ready marker never pairs with a new, cut-off transfer', () => {
    // A previous attempt that staged fully and was never swapped.
    expect(stage({}, { inPlaceAttempt: 'att-0' }).status).toBe(0);
    rmSync(calls);
    const r = stage({ BB_PARTIAL: '1' });
    expect(r.status).not.toBe(0);
    expect(existsSync(join(pgdata, '.vc-reseed-ready'))).toBe(false);
    const g = guard();
    expect(g.status, g.stderr).toBe(0);
    expect(g.stderr).not.toContain('RESEED_SWAPPED');
    expect(read('base/marker')).toBe('live\n');
  });

  it('a stage cut short at ANY command leaves nothing the swap accepts, or the whole tree', () => {
    expect(stage().status).toBe(0);
    const seq = readFileSync(calls, 'utf-8').trim().split('\n');
    const seen: Record<string, number> = {};
    const points = seq.map((name) => {
      seen[name] = (seen[name] ?? 0) + 1;
      return `${name}:${seen[name]}`;
    });
    // Every external command the stage runs is a crash point.
    expect([...new Set(seq)].sort()).toEqual([
      'cat',
      'chown',
      'find',
      'mkdir',
      'mv',
      'pg_basebackup',
      'rm',
      'sed',
      'sync',
      'touch',
    ]);
    const lastSync = `sync:${seen.sync}`;
    expect(points.at(-1)).toBe(lastSync);
    for (const at of points) {
      setup();
      const r = stage({ FAIL_AT: at });
      expect(r.status, `${at} did not fail the stage`).not.toBe(0);
      expect(r.stderr, at).toContain(`injected failure ${at}`);
      // The stage never touches the live cluster.
      expect(cluster(), at).toEqual(LIVE);
      expect(read('base/marker'), at).toBe('live\n');
      const g = guard();
      expect(g.status, `${at}: ${g.stderr}`).toBe(0);
      if (at === lastSync) {
        // The marker is renamed in; only its own durability sync was lost.
        expect(g.stderr, at).toContain('RESEED_SWAPPED att-1');
        expect(read('base/marker'), at).toBe('primary\n');
      } else {
        expect(g.stderr, at).not.toContain('RESEED_SWAPPED');
        expect(cluster(), at).toEqual(LIVE);
        expect(read('base/marker'), at).toBe('live\n');
        expect(existsSync(join(pgdata, '.vc-discard')), at).toBe(false);
      }
    }
  });
});
