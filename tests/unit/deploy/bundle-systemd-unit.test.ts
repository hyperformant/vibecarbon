/**
 * The systemd unit is the ONLY unattended whole-stack recreate path (node
 * reboot / systemctl restart). 2026-07-16 audit: it was baked with the static
 * compose flags and NO replication overlay, so a compose-ha node reboot
 * recreated db without the 5433 publish and --remove-orphans deleted
 * repl-gateway (defined only in the overlay) — silently breaking replication
 * transport until the next deploy. The unit must carry the same runtime
 * overlay conditional as reconcile.sh, escaped for systemd ($$ → literal $,
 * verified on systemd 255, the Ubuntu 24.04 node version).
 */

import { describe, expect, it } from 'vitest';
import { renderReconcileScript, renderSystemdUnit } from '../../../src/lib/deploy/bundle.js';

const FLAGS = '-f docker-compose.yml -f docker-compose.prod.yml';

describe('renderSystemdUnit', () => {
  const unit = renderSystemdUnit('myproj', FLAGS);

  it('ExecStart recreates through bash with the runtime replication-overlay conditional', () => {
    expect(unit).toMatch(
      /ExecStart=\/bin\/bash -c 'docker compose -f docker-compose\.yml -f docker-compose\.prod\.yml \$\$\(\[ -f docker-compose\.replication\.yml \] && echo "-f docker-compose\.replication\.yml"\) up -d --remove-orphans'/,
    );
  });

  it('ExecStop tears down with the same overlay conditional', () => {
    expect(unit).toMatch(
      /ExecStop=\/bin\/bash -c 'docker compose .* \$\$\(\[ -f docker-compose\.replication\.yml \] && echo "-f docker-compose\.replication\.yml"\) down'/,
    );
  });

  it('escapes every command substitution as $$ (a single $ is eaten by systemd expansion)', () => {
    // Any `$(` not preceded by `$` would reach systemd unescaped.
    expect(unit).not.toMatch(/[^$]\$\(/);
  });

  it('runs from the project dir so the overlay [ -f ] test resolves', () => {
    expect(unit).toContain('WorkingDirectory=/opt/myproj');
  });

  it('tests the SAME overlay filename as reconcile.sh (rename must update both)', () => {
    const reconcile = renderReconcileScript('myproj', FLAGS);
    const overlayName = 'docker-compose.replication.yml';
    expect(reconcile).toContain(`[ -f ${overlayName} ]`);
    expect(unit).toContain(`[ -f ${overlayName} ]`);
  });
});
