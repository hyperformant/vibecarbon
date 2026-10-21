import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeRestoreScript } from '../../../src/lib/deploy/compose/index.js';
import { buildRecoveryConfig, renderRecoveryConf } from '../../../src/lib/walg/recovery-config.js';

/**
 * The archive-recovery settings a restore writes into the fetched cluster's
 * postgresql.auto.conf. One builder for both tiers: compose embeds the
 * rendered text in its restore script, k8s receives the same text through
 * RESTORE_RECOVERY_CONF on vibecarbon-infra-secrets (M2: they had drifted
 * before, as two hand-written copies).
 */
describe('buildRecoveryConfig', () => {
  it('latest replays along the base backup timeline to the end of WAL', () => {
    const { lines } = buildRecoveryConfig({ target: 'latest' });
    expect(lines).toContain("recovery_target_timeline = 'current'");
    expect(lines).toContain("recovery_target_action = 'promote'");
    expect(lines).toContain(`restore_command = 'wal-g wal-fetch "%f" "%p"'`);
    expect(lines.join('\n')).not.toMatch(/recovery_target_time\s*=/);
  });

  it('a timestamp stops replay at that instant', () => {
    const { lines } = buildRecoveryConfig({ target: '2026-10-20T09:55:00Z' });
    expect(lines).toContain("recovery_target_time = '2026-10-20T09:55:00Z'");
  });

  it('strips every recovery setting and the write fence before appending', () => {
    for (const target of ['latest', '2026-10-20T09:55:00Z']) {
      const { strip } = buildRecoveryConfig({ target });
      expect(strip).toContain('default_transaction_read_only');
      expect(strip).toContain('restore_command');
      expect(strip).toContain('recovery_target_action');
      expect(strip).toContain('recovery_target_time');
      expect(strip).toContain('recovery_target_timeline');
      // Every other recovery_target_* setting too: a base taken from a cluster
      // restored earlier carries what that restore appended.
      for (const name of ['recovery_target', 'recovery_target_lsn', 'recovery_target_xid']) {
        expect(strip).toContain(name);
      }
    }
  });

  it('refuses anything that is not latest or an ISO-8601 instant', () => {
    expect(() => buildRecoveryConfig({ target: "'; DROP TABLE x; --" })).toThrow(/invalid target/i);
    expect(() => buildRecoveryConfig({ target: '2026-10-20' })).toThrow(/invalid target/i);
  });
});

describe('renderRecoveryConf', () => {
  it('lists the strips first, then the appended lines', () => {
    const text = renderRecoveryConf(buildRecoveryConfig({ target: 'latest' }));
    const rows = text.split('\n');
    const firstAppend = rows.findIndex((r) => !r.startsWith('-'));
    expect(rows.slice(0, firstAppend).every((r) => /^-[a-z_]+$/.test(r))).toBe(true);
    expect(rows.slice(firstAppend).every((r) => !r.startsWith('-'))).toBe(true);
    expect(rows).toContain('-default_transaction_read_only');
  });
});

describe('byte parity between the tiers (M2)', () => {
  const BACKUP = 'base_000000010000000000000002';

  function composeConfBody(script: string): string {
    const m = script.match(/<<'VC_RECOVERY_CONF_EOF'\n([\s\S]*?)\nVC_RECOVERY_CONF_EOF\n/);
    if (!m) throw new Error('no recovery conf heredoc in the compose restore script');
    return m[1];
  }

  for (const target of ['latest', '2026-10-20T09:55:00Z']) {
    it(`the compose script carries exactly the rendered RESTORE_RECOVERY_CONF (${target})`, () => {
      const recoveryConf = renderRecoveryConf(buildRecoveryConfig({ target }));
      const script = composeRestoreScript({ backup: BACKUP, recoveryConf });
      expect(composeConfBody(script)).toBe(recoveryConf);
    });
  }

  it('both tiers apply the conf with the same loop', () => {
    const script = composeRestoreScript({
      backup: BACKUP,
      recoveryConf: renderRecoveryConf(buildRecoveryConfig({ target: 'latest' })),
    });
    const sts = readFileSync(join(process.cwd(), 'carbon/k8s/base/db/statefulset.yaml'), 'utf-8');
    const loop = (text: string) => {
      const m = text.match(
        /while IFS= read -r vc_line; do[\s\S]*?done < "\$VC_RECOVERY_CONF_FILE"/,
      );
      if (!m) throw new Error('no recovery conf apply loop');
      return m[0]
        .split('\n')
        .map((l) => l.trim())
        .join('\n');
    };
    expect(loop(sts)).toBe(loop(script));
  });
});
