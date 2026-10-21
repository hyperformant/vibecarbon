import { describe, expect, it } from 'vitest';
import { composeRestoreScript } from '../../../src/lib/deploy/compose/index.js';
import { buildRecoveryConfig, renderRecoveryConf } from '../../../src/lib/walg/recovery-config.js';

/** The database lineage (system identifier) whose folder holds the backup. */
const LINEAGE = '7699032860122738725';

// ---------------------------------------------------------------------------
// composeRestoreScript() — pure function, no I/O, no SSH.
//
// The recovery settings themselves are buildRecoveryConfig's (tested in
// tests/unit/walg/recovery-config.test.ts); the ordering rules, nothing on the
// live cluster before the fetch, are the census in
// tests/unit/deploy/restore-destroy-before-verify-census.test.ts. This pins
// the script's own contract.
// ---------------------------------------------------------------------------
const BACKUP = 'base_000000010000000000000002';
const conf = (target: string) => renderRecoveryConf(buildRecoveryConfig({ target }));

describe('composeRestoreScript', () => {
  it('fetches the named backup into staging, never LATEST', () => {
    const script = composeRestoreScript({
      lineage: LINEAGE,
      backup: BACKUP,
      recoveryConf: conf('latest'),
    });
    expect(script).toContain(`RESTORE_BACKUP='${BACKUP}'`);
    expect(script).toContain('wal-g backup-fetch "$PGDATA/.vc-restore" "$RESTORE_BACKUP"');
    expect(script).not.toMatch(/backup-fetch[^\n]*LATEST/);
  });

  it('applies the rendered recovery config and recovery.signal to the staged cluster', () => {
    const script = composeRestoreScript({
      lineage: LINEAGE,
      backup: BACKUP,
      recoveryConf: conf('2026-05-31T12:00:00Z'),
    });
    expect(script).toContain("recovery_target_time = '2026-05-31T12:00:00Z'");
    expect(script).toContain('VC_AUTO_CONF="$PGDATA/.vc-restore/postgresql.auto.conf"');
    expect(script).toContain('touch "$PGDATA/.vc-restore/recovery.signal"');
  });

  it('runs under set -euo pipefail against the db container PGDATA', () => {
    const script = composeRestoreScript({
      lineage: LINEAGE,
      backup: BACKUP,
      recoveryConf: conf('latest'),
    });
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('PGDATA=/var/lib/postgresql/data');
  });

  it('swaps under the in-progress marker and leaves .vc-prev for the CLI', () => {
    const script = composeRestoreScript({
      lineage: LINEAGE,
      backup: BACKUP,
      recoveryConf: conf('latest'),
    });
    const lines = script.split('\n').map((l) => l.trim());
    const markerOff = lines.indexOf('rm -f "$VC_MARKER"');
    const swapIn = lines.findIndex((l) => l.includes('mv "$vc_entry" "$PGDATA/"'));
    const lastAside = lines.reduce(
      (last, l, i) => (/mv "\$vc_entry" "\$PGDATA\/\.vc-(prev|discard)\/"/.test(l) ? i : last),
      -1,
    );
    expect(lastAside).toBeGreaterThan(-1);
    expect(swapIn).toBeGreaterThan(lastAside);
    expect(markerOff).toBeGreaterThan(swapIn);
    // Every move aside happens with the marker already written.
    const firstAside = lines.findIndex((l) =>
      /mv "\$vc_entry" "\$PGDATA\/\.vc-(prev|discard)\/"/.test(l),
    );
    const firstMarker = lines.findIndex((l) => /(: |echo in )> "\$VC_MARKER"/.test(l));
    expect(firstMarker).toBeLessThan(firstAside);
    expect(script).not.toMatch(/rm -rf "\$PGDATA\/\.vc-prev"/);
  });

  it('rejects anything that is not a wal-g backup name (injection guard)', () => {
    expect(() =>
      composeRestoreScript({ lineage: LINEAGE, backup: 'LATEST', recoveryConf: conf('latest') }),
    ).toThrow(/not a wal-g backup name/);
    expect(() =>
      composeRestoreScript({
        lineage: LINEAGE,
        backup: "base_1'; rm -rf / #",
        recoveryConf: conf('latest'),
      }),
    ).toThrow(/not a wal-g backup name/);
    expect(() =>
      composeRestoreScript({
        lineage: LINEAGE,
        backup: 'base_000000010000000000000002_D_000000010000000000000001',
        recoveryConf: conf('latest'),
      }),
    ).not.toThrow();
  });

  it('requires the rendered recovery config', () => {
    expect(() =>
      composeRestoreScript({ lineage: LINEAGE, backup: BACKUP, recoveryConf: '' }),
    ).toThrow(/recoveryConf/);
    expect(() =>
      composeRestoreScript({
        lineage: LINEAGE,
        backup: BACKUP,
        recoveryConf: 'x\nVC_RECOVERY_CONF_EOF\nrm -rf /',
      }),
    ).toThrow(/recoveryConf/);
  });
});
