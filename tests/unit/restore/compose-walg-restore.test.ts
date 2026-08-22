import { describe, expect, it } from 'vitest';
import { composeRestoreScript } from '../../../src/lib/deploy/compose/index.js';

// ---------------------------------------------------------------------------
// composeRestoreScript() — pure function, no I/O, no SSH
// ---------------------------------------------------------------------------
describe('composeRestoreScript', () => {
  it('contains wal-g backup-fetch', () => {
    const script = composeRestoreScript('latest');
    expect(script).toContain('wal-g backup-fetch');
  });

  it('contains restore_command with wal-g wal-fetch', () => {
    const script = composeRestoreScript('latest');
    expect(script).toContain('restore_command');
    expect(script).toContain('wal-g wal-fetch');
  });

  it('contains recovery_target_action = promote', () => {
    const script = composeRestoreScript('latest');
    expect(script).toContain("recovery_target_action = 'promote'");
  });

  it('pins recovery_target_timeline to current (avoid chasing divergent HA timelines)', () => {
    const script = composeRestoreScript('latest');
    expect(script).toContain("recovery_target_timeline = 'current'");
    // and the dedup strip must clear it too so it doesn't accumulate
    expect(script).toContain('/^recovery_target_timeline =/d');
  });

  it('touches recovery.signal', () => {
    const script = composeRestoreScript('latest');
    expect(script).toContain('recovery.signal');
  });

  it('does NOT echo a recovery_target_time setting for "latest"', () => {
    const script = composeRestoreScript('latest');
    // The stale-settings strip line mentions recovery_target_time, but no
    // `echo "recovery_target_time = ..."` append line should be emitted.
    // (Match the trailing ` =` so this does NOT false-match the always-present
    // `recovery_target_timeline = 'current'` line, which shares a prefix.)
    expect(script).not.toContain('echo "recovery_target_time =');
  });

  it('echoes recovery_target_time for an ISO-8601 timestamp', () => {
    const script = composeRestoreScript('2026-05-31T12:00:00Z');
    expect(script).toContain('echo "recovery_target_time = \'2026-05-31T12:00:00Z\'"');
  });

  it('still contains all required recovery fields when given a PITR timestamp', () => {
    const script = composeRestoreScript('2026-05-31T12:00:00Z');
    expect(script).toContain('wal-g backup-fetch');
    expect(script).toContain('restore_command');
    expect(script).toContain('wal-g wal-fetch');
    expect(script).toContain("recovery_target_action = 'promote'");
    expect(script).toContain('recovery.signal');
  });

  it('sets PGDATA to /var/lib/postgresql/data', () => {
    const script = composeRestoreScript('latest');
    expect(script).toContain('/var/lib/postgresql/data');
  });

  it('appends the recovery config with >> (not a truncating >)', () => {
    const script = composeRestoreScript('latest');
    expect(script).toContain('>> "$PGDATA/postgresql.auto.conf"');
    // No truncating single-> redirect into the auto.conf
    expect(script).not.toMatch(/[^>]> "\$PGDATA\/postgresql\.auto\.conf"/);
  });

  it('runs under set -euo pipefail', () => {
    expect(composeRestoreScript('latest')).toContain('set -euo pipefail');
  });

  it('clears PGDATA in-container, guarded by PG_VERSION', () => {
    const script = composeRestoreScript('latest');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${PGDATA:?} is bash in the generated script, not a JS template placeholder
    expect(script).toContain('rm -rf "${PGDATA:?}/"*');
    expect(script).toContain('if [ -f "$PGDATA/PG_VERSION" ]; then');
  });

  it('strips stale recovery settings before re-appending (no accumulation)', () => {
    const script = composeRestoreScript('latest');
    expect(script).toContain('sed -i');
    expect(script).toContain('/^restore_command =/d');
    expect(script).toContain('/^recovery_target_action =/d');
    expect(script).toContain('/^recovery_target_time =/d');
  });

  it('throws for an invalid target (injection guard)', () => {
    expect(() => composeRestoreScript("'; rm -rf / #")).toThrow(/invalid target/i);
  });

  it('accepts "latest" as a valid target', () => {
    expect(() => composeRestoreScript('latest')).not.toThrow();
  });

  it('accepts a UTC ISO-8601 timestamp as a valid PITR target', () => {
    expect(() => composeRestoreScript('2026-05-31T12:00:00Z')).not.toThrow();
  });

  it('accepts an ISO-8601 timestamp with +00:00 offset', () => {
    expect(() => composeRestoreScript('2026-05-31T12:00:00+00:00')).not.toThrow();
  });

  it('rejects a bare date (not an ISO datetime)', () => {
    expect(() => composeRestoreScript('2026-05-31')).toThrow(/invalid target/i);
  });
});
