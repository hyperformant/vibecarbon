import { describe, expect, it } from 'vitest';
import { renderReconcileScript } from '../../../src/lib/deploy/bundle.js';

// ---------------------------------------------------------------------------
// compose-ha replication overlay (5433) preservation in reconcile.sh
//
// reconcile.sh is baked at bundle time with static composeFlags. On a
// compose-ha server, docker-compose.replication.yml maps db:5432 → host:5433
// so pg_basebackup and streaming replication can reach raw postgres. Any
// `docker compose up -d` that omits the overlay recreates the db container
// WITHOUT the 5433 mapping, silently dropping the replication listener.
//
// Fix: embed a shell conditional that appends the overlay at runtime when the
// file is present. On single-server compose the file never exists — no-op.
// ---------------------------------------------------------------------------

const REPL_GUARD = '[ -f docker-compose.replication.yml ]';
const REPL_FLAG = '-f docker-compose.replication.yml';

describe('renderReconcileScript — replication overlay guard', () => {
  it('includes the [ -f docker-compose.replication.yml ] guard in the up command', () => {
    const script = renderReconcileScript(
      'myapp',
      '-f docker-compose.yml -f docker-compose.prod.yml',
    );
    // The guard must be present so the overlay is conditionally appended at runtime
    expect(script).toContain(REPL_GUARD);
    // The flag value that the conditional echoes
    expect(script).toContain(REPL_FLAG);
  });

  it('includes the replication guard in the pull step (non-fast mode)', () => {
    const script = renderReconcileScript(
      'myapp',
      '-f docker-compose.yml -f docker-compose.prod.yml',
      false,
    );
    // Both pull and up commands must include the guard so an HA server keeps
    // the overlay across both phases of reconcile.
    const guardCount = (
      script.match(new RegExp(REPL_GUARD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []
    ).length;
    expect(guardCount).toBeGreaterThanOrEqual(2);
  });

  it('omits the pull step in fast mode but still guards the up command', () => {
    const script = renderReconcileScript(
      'myapp',
      '-f docker-compose.yml -f docker-compose.prod.yml',
      true,
    );
    // Fast mode skips the pull step — but the up command must still carry the guard
    expect(script).toContain(REPL_GUARD);
    expect(script).not.toContain('pull --quiet');
  });

  it('places the replication flag AFTER the static compose flags (order matters for overlay merging)', () => {
    const staticFlags = '-f docker-compose.yml -f docker-compose.prod.yml';
    const script = renderReconcileScript('myapp', staticFlags);
    // Static flags should appear before the shell conditional in the command
    const upLine = script.split('\n').find((l) => l.includes('up -d'));
    expect(upLine).toBeDefined();
    expect(upLine?.indexOf(staticFlags)).toBeLessThan(upLine?.indexOf(REPL_GUARD) ?? -1);
  });

  it('still runs set -e and the standard reconcile steps', () => {
    const script = renderReconcileScript(
      'myapp',
      '-f docker-compose.yml -f docker-compose.prod.yml',
    );
    expect(script).toContain('set -e');
    expect(script).toContain('up -d --remove-orphans');
    expect(script).toContain('Reconciliation complete.');
  });

  it('uses a $(...) subshell form so the guard is evaluated by the shell, not by JS', () => {
    const script = renderReconcileScript(
      'myapp',
      '-f docker-compose.yml -f docker-compose.prod.yml',
    );
    // Must be a shell command substitution, not a hardcoded flag string
    expect(script).toContain(`$([ -f docker-compose.replication.yml ] && echo '${REPL_FLAG}')`);
  });
});
