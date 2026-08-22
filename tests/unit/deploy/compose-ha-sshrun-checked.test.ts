import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sshRunChecked } from '../../../src/lib/deploy/compose/index.js';

// `sshRun` NEVER throws — it answers `false`. That contract is deliberate and
// load-bearing for the poll loops in ha.js, which read `false` as "not ready
// yet". But it also meant two broken shapes were live across the HA
// replication and failover paths:
//
//   1. `await sshRun(...)` with the result discarded — the command could fail
//      and the deploy carried on. A failed CREATE ROLE surfaced minutes later
//      as `FATAL: role "replicator" does not exist`, i.e. exactly the error the
//      check 60 lines below it had been added to prevent.
//
//   2. `try { await sshRun(...) } catch { ... }` — a catch block that CANNOT
//      run. The worst instance was failover's anti-split-brain step: the warn
//      was dead code and the spinner printed "Old primary services stopped"
//      unconditionally, including when the old primary was unreachable, which
//      is usually WHY a failover is happening. It reported success in the one
//      case it exists to catch.
//
//   3. The "wait for PostgreSQL to be ready" loop combined both: the catch
//      could not fire, so `return` ran on the FIRST iteration. It waited for
//      nothing (and had no sleep either), so configurePrimaryReplication
//      returned while the db restart was still in flight and the standby's
//      pg_basebackup raced a postmaster that was not yet accepting connections.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const haSrc = readFileSync(join(repoRoot, 'src/lib/deploy/compose/ha.js'), 'utf-8');

/** Commands that must abort the deploy when they fail. */
const MUST_SUCCEED = [
  { what: 'replicator role', match: /replicator role \+ replication slot creation/ },
  { what: 'WAL settings', match: /WAL replication settings \(ALTER SYSTEM\)/ },
  { what: 'primary db restart', match: /primary db restart/ },
  { what: 'slot re-create', match: /replication-slot re-create on the primary/ },
  { what: 'primary repl-gateway', match: /primary's repl-gateway start/ },
  { what: 'standby repl-gateway', match: /standby's repl-gateway start/ },
];

describe('compose-ha: commands that must succeed use sshRunChecked', () => {
  it('sshRunChecked throws when the underlying run answers false', async () => {
    const failing = async () => false;
    await expect(
      sshRunChecked('10.0.0.1', '/tmp/key', 'true', { what: 'demo step', runImpl: failing }),
    ).rejects.toThrow(/demo step failed on 10\.0\.0\.1/);
  });

  it.each(MUST_SUCCEED)('$what is issued through sshRunChecked', ({ match }) => {
    expect(haSrc).toMatch(match);
  });

  it('no `try { await sshRun(...) } catch` remains — sshRun cannot throw', () => {
    // A catch around a bare sshRun is always dead code. Matches the await and
    // the catch within a short window so an unrelated try/catch does not trip.
    // Judge CODE, not prose: the fix's own comments quote the broken shape.
    const code = haSrc
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    const deadCatch = /try\s*\{\s*await sshRun\((?:[^}]|\}(?!\s*catch))*?\}\s*catch/g;
    const hits = code.match(deadCatch) ?? [];
    expect(
      hits,
      'sshRun answers `false` and never throws, so this catch can never run. ' +
        'Either check the return value explicitly or use sshRunChecked.',
    ).toEqual([]);
  });

  it('the pg-ready loop actually waits: it checks the result and sleeps', () => {
    const loop = haSrc.split('// Wait for PostgreSQL to be ready again')[1]?.slice(0, 1200) ?? '';
    expect(loop, 'loop must inspect the probe result rather than returning blind').toMatch(
      /ready\s*!==\s*false/,
    );
    expect(loop, 'loop must sleep between attempts').toMatch(/setTimeout/);
    expect(loop, 'exhausting the budget must fail loudly, not fall through').toMatch(/throw new/);
  });

  it('failover reports split-brain risk instead of asserting success', () => {
    expect(haSrc).toMatch(/SPLIT-BRAIN RISK/);
    expect(haSrc, 'the spinner must not claim the old primary stopped when it did not').toMatch(
      /Old primary NOT stopped/,
    );
  });
});
