import { describe, expect, it } from 'vitest';
import { composeRestoreScript } from '../../../src/lib/deploy/compose/index.js';
import { buildRecoveryConfig, renderRecoveryConf } from '../../../src/lib/walg/recovery-config.js';

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
    const script = composeRestoreScript({ backup: BACKUP, recoveryConf: conf('latest') });
    expect(script).toContain(`RESTORE_BACKUP='${BACKUP}'`);
    expect(script).toContain('wal-g backup-fetch "$PGDATA/.vc-restore" "$RESTORE_BACKUP"');
    expect(script).not.toMatch(/backup-fetch[^\n]*LATEST/);
  });

  it('applies the rendered recovery config and recovery.signal to the staged cluster', () => {
    const script = composeRestoreScript({
      backup: BACKUP,
      recoveryConf: conf('2026-05-31T12:00:00Z'),
    });
    expect(script).toContain("recovery_target_time = '2026-05-31T12:00:00Z'");
    expect(script).toContain('VC_AUTO_CONF="$PGDATA/.vc-restore/postgresql.auto.conf"');
    expect(script).toContain('touch "$PGDATA/.vc-restore/recovery.signal"');
  });

  it('runs under set -euo pipefail against the db container PGDATA', () => {
    const script = composeRestoreScript({ backup: BACKUP, recoveryConf: conf('latest') });
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('PGDATA=/var/lib/postgresql/data');
  });

  it('swaps under the in-progress marker and leaves .vc-prev for the CLI', () => {
    const script = composeRestoreScript({ backup: BACKUP, recoveryConf: conf('latest') });
    const lines = script.split('\n');
    const markerOn = lines.findIndex((l) => l.includes(': > "$VC_MARKER"'));
    const markerOff = lines.indexOf('rm -f "$VC_MARKER"');
    const intoPrev = lines.findIndex((l) => l.includes('"$PGDATA/.vc-prev/"'));
    expect(markerOn).toBeGreaterThan(-1);
    expect(intoPrev).toBeGreaterThan(markerOn);
    expect(markerOff).toBeGreaterThan(intoPrev);
    expect(script).not.toMatch(/rm -rf "\$PGDATA\/\.vc-prev"/);
  });

  it('rejects anything that is not a wal-g backup name (injection guard)', () => {
    expect(() => composeRestoreScript({ backup: 'LATEST', recoveryConf: conf('latest') })).toThrow(
      /not a wal-g backup name/,
    );
    expect(() =>
      composeRestoreScript({ backup: "base_1'; rm -rf / #", recoveryConf: conf('latest') }),
    ).toThrow(/not a wal-g backup name/);
    expect(() =>
      composeRestoreScript({
        backup: 'base_000000010000000000000002_D_000000010000000000000001',
        recoveryConf: conf('latest'),
      }),
    ).not.toThrow();
  });

  it('requires the rendered recovery config', () => {
    expect(() => composeRestoreScript({ backup: BACKUP, recoveryConf: '' })).toThrow(
      /recoveryConf/,
    );
    expect(() =>
      composeRestoreScript({ backup: BACKUP, recoveryConf: 'x\nVC_RECOVERY_CONF_EOF\nrm -rf /' }),
    ).toThrow(/recoveryConf/);
  });
});
