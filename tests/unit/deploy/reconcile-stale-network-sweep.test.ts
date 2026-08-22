import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderReconcileScript } from '../../../src/lib/deploy/bundle.js';

// ---------------------------------------------------------------------------
// Stale-network self-heal sweep in reconcile.sh
//
// When a network's definition changes (e.g. the base-file IPAM subnet pin
// landing on a server whose network predates it), `docker compose up` stops
// every attached container, removes the network and creates a replacement —
// but only RECREATES containers whose own config-hash changed. Every other
// container keeps its endpoint config pointing at the dead network ID and can
// never start again: "Error response from daemon: network <id> not found".
// A crashed deploy then leaves the whole stack down, and every retry hits the
// same wall (vibecarbon-web prod outage, 2026-07-18).
//
// Fix: before `up`, reconcile.sh removes project containers that reference a
// network ID that no longer exists. Such containers are unstartable by
// definition, so removal is always safe — `up -d` recreates them against the
// current network.
// ---------------------------------------------------------------------------

const FLAGS = '-f docker-compose.yml -f docker-compose.prod.yml';

const LIVE_NET = 'b1fddfdeae76339607d4b285063498c297f1834b35126dd496e960c9c43e3203';
const DEAD_NET = 'e8a0c60781406d1325b492be65c08094a8e0033df956e6ee3c08a74377295bd1';
const STALE_ID = 'aaaaaaaaaaaa';
const HEALTHY_ID = 'bbbbbbbbbbbb';

/**
 * Stub `docker` that serves a fixed world: one live network, one healthy
 * container attached to it, one stale container attached to a network that no
 * longer exists. Every invocation is appended to argv.log; `rm` calls land in
 * rm.log so assertions can see exactly what the sweep removed.
 */
function writeDockerStub(dir: string): void {
  const stub = `#!/bin/bash
echo "$@" >> "${dir}/argv.log"
case "$1" in
  network)
    # docker network ls -q --no-trunc
    echo "${LIVE_NET}"
    ;;
  ps)
    # docker ps -aq --filter label=...
    echo "${STALE_ID}"
    echo "${HEALTHY_ID}"
    ;;
  inspect)
    fmt="$3"; target="$4"
    if [[ "$fmt" == *NetworkID* ]]; then
      if [ "$target" = "${STALE_ID}" ]; then echo "${DEAD_NET} "; else echo "${LIVE_NET} "; fi
    else
      # name lookup for logging
      echo "/myapp-db"
    fi
    ;;
  rm)
    echo "$@" >> "${dir}/rm.log"
    ;;
  compose)
    exit 0
    ;;
esac
exit 0
`;
  writeFileSync(join(dir, 'docker'), stub);
  chmodSync(join(dir, 'docker'), 0o755);
}

function runRendered(script: string): { dir: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-sweep-'));
  writeDockerStub(dir);
  // The rendered script cd's into /opt/<project>, which doesn't exist in a
  // test sandbox — repoint PROJECT_DIR at the temp dir. Everything else runs
  // verbatim.
  const projectDir = join(dir, 'project');
  mkdirSync(projectDir);
  const patched = script.replace(/^PROJECT_DIR=.*$/m, `PROJECT_DIR="${projectDir}"`);
  const scriptPath = join(dir, 'reconcile.sh');
  writeFileSync(scriptPath, patched);
  const stdout = execFileSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  return { dir, stdout };
}

describe('renderReconcileScript — stale network reference sweep', () => {
  it('sweeps before `up` and scopes to the compose project label', () => {
    const script = renderReconcileScript('myapp', FLAGS);
    expect(script).toContain('label=com.docker.compose.project=myapp');
    // The sweep must run before the up command — a stale container removed
    // after `up` has already failed is no fix at all.
    expect(script.indexOf('com.docker.compose.project')).toBeLessThan(
      script.indexOf('up -d --remove-orphans'),
    );
    // Full network IDs on both sides of the comparison (inspect emits 64-char
    // IDs; `network ls -q` truncates without --no-trunc).
    expect(script).toContain('network ls -q --no-trunc');
  });

  it('is present in fast mode too (fast skips pull, not self-heal)', () => {
    const script = renderReconcileScript('myapp', FLAGS, true);
    expect(script).toContain('label=com.docker.compose.project=myapp');
  });

  it('removes exactly the container whose network no longer exists', () => {
    const { dir } = runRendered(renderReconcileScript('myapp', FLAGS));
    const rmLog = readFileSync(join(dir, 'rm.log'), 'utf8');
    expect(rmLog).toContain(STALE_ID);
    expect(rmLog).not.toContain(HEALTHY_ID);
    // Forced removal: a crash-looping container stuck on the dead network is
    // in Restarting, not Exited, and plain `rm` refuses it.
    expect(rmLog).toMatch(/rm -f/);
  });

  it('names the removed container and the dead network in the log output', () => {
    const { stdout } = runRendered(renderReconcileScript('myapp', FLAGS));
    expect(stdout).toContain('myapp-db');
    expect(stdout).toContain(DEAD_NET.slice(0, 12));
  });

  it('still reaches the up step when nothing is stale (sweep is a no-op pass-through)', () => {
    const { dir, stdout } = runRendered(renderReconcileScript('myapp', FLAGS, true));
    expect(stdout).toContain('Reconciliation complete.');
    const argv = readFileSync(join(dir, 'argv.log'), 'utf8');
    expect(argv).toMatch(/compose .*up -d --remove-orphans/);
  });
});
