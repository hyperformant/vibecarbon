import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderBundle, renderReconcileScript } from '../../../src/lib/deploy/bundle.js';
import {
  REGISTRY_CONTAINER,
  REGISTRY_IMAGE,
  REGISTRY_PORT,
  REGISTRY_PREFIX,
  REGISTRY_VOLUME,
  registryEnsureShell,
  registryRunCommand,
} from '../../../src/lib/deploy/compose/registry-config.js';
import { renderDoUserData } from '../../../src/lib/iac/programs/digitalocean-compose.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('registry-config (pure)', () => {
  it('is a zero-import module — safe for bundle.js to load without the compose SSH stack', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../src/lib/deploy/compose/registry-config.js', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/^\s*import\b/m);
  });

  it('exports the expected constant shape', () => {
    expect(REGISTRY_IMAGE).toBe('registry:2');
    expect(REGISTRY_CONTAINER).toBe('vibecarbon-registry');
    expect(REGISTRY_PORT).toBe(5000);
    expect(REGISTRY_VOLUME).toBe('vibecarbon-registry-data');
    expect(REGISTRY_PREFIX).toBe('127.0.0.1:5000/');
  });

  it('pins a concrete tag — never `latest` and never a bare digest reference', () => {
    expect(REGISTRY_IMAGE).not.toBe('registry:latest');
    expect(REGISTRY_IMAGE).not.toMatch(/@sha256:/);
    expect(REGISTRY_IMAGE).toMatch(/^registry:\d/);
  });

  describe('registryRunCommand', () => {
    const cmd = registryRunCommand();

    it('is a standalone docker run, never a compose service', () => {
      expect(cmd.startsWith('docker run')).toBe(true);
      expect(cmd).not.toContain('docker compose');
    });

    it('binds loopback-only, never 0.0.0.0 or a bare unbound port publish', () => {
      expect(cmd).toContain('-p 127.0.0.1:5000:5000');
      expect(cmd).not.toContain('0.0.0.0');
      expect(cmd).not.toMatch(/(?<!127\.0\.0\.1:)\b5000:5000\b/);
    });

    it('carries the persistent volume, restart policy, name, and terminal image token', () => {
      expect(cmd).toContain('-v vibecarbon-registry-data:/var/lib/registry');
      expect(cmd).toContain('--restart unless-stopped');
      expect(cmd).toContain('--name vibecarbon-registry');
      expect(cmd.trim().endsWith('registry:2')).toBe(true);
    });
  });

  describe('registryEnsureShell', () => {
    const shell = registryEnsureShell();

    it('gates every mutating step with `|| true` (reconcile.sh runs under set -e; the registry is ADDITIVE)', () => {
      expect(shell).toContain('docker rm -f vibecarbon-registry 2>/dev/null || true');
      expect(shell).toContain(`${registryRunCommand()} || true`);
    });

    it('checks running status via the pinned container-name filter before touching anything', () => {
      expect(shell).toContain(
        'docker ps --filter name=^vibecarbon-registry$ --filter status=running -q',
      );
      expect(shell.indexOf('docker ps')).toBeLessThan(shell.indexOf('docker rm -f'));
    });

    it('embeds the exact same run command registryRunCommand() produces (no drift between call sites)', () => {
      expect(shell).toContain(registryRunCommand());
    });
  });
});

// ---------------------------------------------------------------------------
// R9: reconcile.sh self-heals the registry. Every deploy re-stages
// reconcile.sh (bundle.js) and startComposeStack executes it, so a
// wedged/removed registry container heals on the next deploy without
// operator intervention. Runs AFTER dockerhubLogin in the deploy plan
// (deploy-plan.js), so this ensure's Hub pull is authenticated even when the
// deploy-time (pre-login) ensure was rate-limited — the Option-B cold-deploy
// safety net (`--restart unless-stopped` on the container itself covers
// reboots; this covers removal/wedge).
// ---------------------------------------------------------------------------
describe('renderReconcileScript embeds the registry ensure (R9, render pin)', () => {
  it('places the ensure block after the stale-network sweep loop and before any `docker compose` op', () => {
    const script = renderReconcileScript(
      'myapp',
      '-f docker-compose.yml -f docker-compose.prod.yml',
    );
    const sweepEndIdx = script.indexOf('docker rm -f "$container_id" > /dev/null || true');
    const ensureIdx = script.indexOf(registryEnsureShell());
    const composeIdx = script.indexOf('docker compose');
    expect(sweepEndIdx).toBeGreaterThan(0);
    expect(ensureIdx).toBeGreaterThan(sweepEndIdx);
    expect(composeIdx).toBeGreaterThan(ensureIdx);
  });

  it('embeds the exact registryEnsureShell() text verbatim (single source of truth, no drift)', () => {
    const script = renderReconcileScript('myapp', '-f docker-compose.yml');
    expect(script).toContain(registryEnsureShell());
  });

  it('is present in fast mode too (fast only skips the pull step, not self-heal)', () => {
    const script = renderReconcileScript('myapp', '-f docker-compose.yml', true);
    expect(script).toContain(registryEnsureShell());
  });
});

// ---------------------------------------------------------------------------
// The ensure is UNCONDITIONAL across build modes and topologies — a decision,
// not an accident. Only compose-single `local` mode ever pushes to the
// registry; `direct`, `push` (GHCR), both compose-ha nodes and scale's
// replacement servers get an idle one. Rationale (measured cost, build mode
// not being durable state, and scale.js having no build-mode information to
// thread a gate through) lives in registryEnsureShell()'s docblock. These
// tests fail loudly if someone mode-gates the embed without revisiting it.
// ---------------------------------------------------------------------------
describe('registry ensure ships for EVERY compose mode (deliberate, not incidental)', () => {
  // renderBundle reads process.cwd(), so each case runs in a throwaway
  // project dir — same fixture shape as bundle-env-overrides.test.ts.
  function withProjectDir<T>(fn: () => T): T {
    const cwdBackup = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'vc-registry-mode-'));
    writeFileSync(join(dir, '.env'), 'FOO=bar\n');
    try {
      process.chdir(dir);
      return fn();
    } finally {
      process.chdir(cwdBackup);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The reconcile.sh renderBundle stages for a given deploy shape. */
  function reconcileFor(options: Record<string, unknown>): string {
    return withProjectDir(() => {
      const stage = renderBundle('myapp', options);
      try {
        return readFileSync(join(stage, 'reconcile.sh'), 'utf8');
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    });
  }

  // `local` and `direct` both stamp APP_IMAGE=<proj>-app:local (only `local`
  // pushes; `direct` builds on the server), `push` stamps a GHCR ref — that
  // image ref is the ONLY build-mode signal reaching bundle.js today, and it
  // must not become a gate.
  const modes: Array<[string, string]> = [
    ['local (the only mode that pushes)', 'myapp-app:local'],
    ['direct (builds on the server, never pushes)', 'myapp-app:local'],
    ['push (GHCR; server pulls, never pushes)', 'ghcr.io/owner/myapp:abc1234'],
  ];

  it.each(modes)('%s → reconcile.sh still carries the ensure', (_label, image) => {
    expect(reconcileFor({ image })).toContain(registryEnsureShell());
  });

  it('compose-ha (both nodes run this same bundle) carries the ensure alongside the replication overlay', () => {
    // compose-ha renders ONE bundle and startComposeStack runs it on primary
    // AND standby, so there is no per-node rendering seam to gate on either.
    const script = reconcileFor({ image: 'myapp-app:local' });
    expect(script).toContain(registryEnsureShell());
    expect(script).toContain('docker-compose.replication.yml');
  });

  it('add-on overlays (observability/redis) do not change whether it ships', () => {
    const script = reconcileFor({
      image: 'ghcr.io/owner/myapp:abc1234',
      observability: true,
      redis: true,
    });
    expect(script).toContain(registryEnsureShell());
  });

  it('renderReconcileScript takes no mode/tier parameter — nothing to forget to pass', () => {
    // Guards the footgun the universal embed exists to avoid: a defaulting
    // mode flag threaded orchestrator → renderBundle → here would silently
    // drop the self-heal for any caller that omits it (scale.js has no build
    // mode at all). Signature is (projectName, composeFlags, isFast = false).
    expect(renderReconcileScript.length).toBe(2);
  });
});

describe('reconcile.sh self-heals the registry (functional, stub docker)', () => {
  const FLAGS = '-f docker-compose.yml';

  /**
   * Stub `docker` scoped to registry-ensure behavior. The stale-network
   * sweep's own `docker ps -aq --filter label=...` call is answered with an
   * empty container inventory (grep-gated on the registry's own filter
   * string) so the sweep is always a pass-through no-op here — its
   * behavior is covered separately by reconcile-stale-network-sweep.test.ts.
   * `registryRunning` toggles whether the registry-status `docker ps`
   * reports a running container; `runFails` makes `docker run` exit 1 to
   * prove the `|| true` guard holds under the script's `set -e`.
   */
  function writeDockerStub(
    dir: string,
    opts: { registryRunning?: boolean; runFails?: boolean },
  ): void {
    const stub = `#!/bin/bash
echo "$@" >> "${dir}/argv.log"
case "$1" in
  ps)
    if echo "$*" | grep -q "vibecarbon-registry"; then
      ${opts.registryRunning ? 'echo "existing-container-id"' : ': # not running: empty stdout'}
    fi
    ;;
  network)
    ;;
  rm)
    echo "$@" >> "${dir}/rm.log"
    ;;
  run)
    echo "$@" >> "${dir}/run.log"
    ${opts.runFails ? 'exit 1' : ':'}
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

  function runRendered(opts: { registryRunning?: boolean; runFails?: boolean }): {
    dir: string;
    status: number;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'reconcile-registry-'));
    writeDockerStub(dir, opts);
    const projectDir = join(dir, 'project');
    mkdirSync(projectDir);
    const script = renderReconcileScript('myapp', FLAGS);
    const patched = script.replace(/^PROJECT_DIR=.*$/m, `PROJECT_DIR="${projectDir}"`);
    const scriptPath = join(dir, 'reconcile.sh');
    writeFileSync(scriptPath, patched);
    let status = 0;
    try {
      execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
    } catch (err) {
      status = (err as { status?: number }).status ?? 1;
    }
    return { dir, status };
  }

  it('registry absent → exactly one `docker run` with the pinned args', () => {
    const { dir, status } = runRendered({ registryRunning: false });
    expect(status).toBe(0);
    const runLog = readFileSync(join(dir, 'run.log'), 'utf8').trim().split('\n').filter(Boolean);
    expect(runLog).toHaveLength(1);
    expect(runLog[0]).toBe(registryRunCommand().replace(/^docker /, ''));
  });

  it('registry running → no `docker run`', () => {
    const { dir, status } = runRendered({ registryRunning: true });
    expect(status).toBe(0);
    const argv = readFileSync(join(dir, 'argv.log'), 'utf8');
    expect(argv).not.toMatch(/^run /m);
  });

  it('`docker run` failing → script still exits 0 (`|| true` holds under `set -e`)', () => {
    const { dir, status } = runRendered({ registryRunning: false, runFails: true });
    expect(status).toBe(0);
    const runLog = readFileSync(join(dir, 'run.log'), 'utf8');
    expect(runLog).toContain('vibecarbon-registry');
  });
});

// ---------------------------------------------------------------------------
// R8: the registry stays a standalone container, absent from every compose
// file and overlay this repo ships (base, prod, override, dns01.prod, and
// the metabase/n8n add-on triples) — never a compose-managed service subject
// to the network-recreate hazard class (project_compose_overlay_network_recreate).
// ---------------------------------------------------------------------------
describe('R8: registry is standalone — never a compose service, across every compose file', () => {
  const composeFiles = [
    'carbon/docker-compose.yml',
    'carbon/docker-compose.prod.yml',
    'carbon/docker-compose.override.yml',
    'carbon/docker-compose.dns01.prod.yml',
    'carbon/docker-compose.metabase.yml',
    'carbon/docker-compose.metabase.prod.yml',
    'carbon/docker-compose.metabase.override.yml',
    'carbon/docker-compose.n8n.yml',
    'carbon/docker-compose.n8n.prod.yml',
    'carbon/docker-compose.n8n.override.yml',
  ];

  it('knows about every carbon/docker-compose*.yml in the repo', () => {
    // Without this, a DELETED file fails loudly (readFileSync throws) but a
    // NEW one silently escapes the scan below — a fresh overlay could declare
    // a `registry` service and nothing would notice. Mirrors the Dockerfile
    // inventory assertion in walg-dockerfile-arch.test.ts (PR #205).
    //
    // GIT-TRACKED files, not readdirSync: carbon/ legitimately hosts
    // generated, gitignored compose artifacts on dev machines (e.g. the
    // dev-init overlay `up` writes, whose header says "DO NOT COMMIT"), and
    // readdirSync counted them — failing this suite locally while CI's fresh
    // checkout passed. Only tracked files ship in the package, so tracked is
    // the honest inventory; a new overlay trips this the moment it is
    // `git add`ed.
    //
    // `git commit` exports GIT_DIR to every hook it runs, and git-hooks/pre-commit
    // runs this very suite — so the probe has to be correct with git's ambient
    // env set. Two layers, each measured against a real hook env:
    //
    //   1. ROOT-relative pathspec, run from ROOT (never cwd=carbon/ with a bare
    //      one). An exported GIT_DIR with no GIT_WORK_TREE makes git treat the
    //      process's CWD as the work-tree root, so `git ls-files
    //      'docker-compose*.yml'` from carbon/ matched ZERO files: the guard
    //      compared [] against its inventory on every `git commit`, while
    //      passing every time the suite was run by hand (PR #233).
    //   2. SCRUBBED git env for the subprocess. (1) holds under GIT_DIR alone —
    //      including from a linked worktree, where GIT_DIR is an absolute path
    //      into the shared `.git/worktrees/<name>` — but NOT under GIT_DIR +
    //      GIT_WORK_TREE: a GIT_WORK_TREE naming a different checkout silently
    //      returns [] again, and a temporary GIT_INDEX_FILE (what partial-staging
    //      hook wrappers set) makes git read an index that is not the repo's.
    //      Dropping the four variables makes the probe read the repo the way an
    //      interactive shell does, whatever wrapper sits in the middle (PR #234).
    //
    // Belt and braces on purpose: this guard's whole job is to notice a NEW
    // compose file, and every one of those failure modes makes it see none.
    const gitEnv = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) {
      delete gitEnv[key];
    }
    const tracked = execFileSync('git', ['ls-files', 'carbon/docker-compose*.yml'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: gitEnv,
    })
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(tracked).toEqual([...composeFiles].sort());
  });

  it.each(composeFiles)(
    '%s declares no `registry` service and does not reference registry:2',
    (rel) => {
      const yaml = read(rel);
      expect(yaml, `${rel} declares a registry service`).not.toMatch(/^\s{2,}registry:\s*$/m);
      expect(yaml, `${rel} references registry:2`).not.toContain('registry:2');
    },
  );

  it("ensureComposeRegistry's command is `docker run`, never `docker compose` (structural: registry.js source)", () => {
    const src = read('src/lib/deploy/compose/registry.js');
    expect(src).not.toContain('docker compose');
  });
});

// ---------------------------------------------------------------------------
// R11, Option B (OWNER RULING, Brandon, 2026-07-29, in-session): no cloud-init
// pre-pull of registry:2 on ANY provider. On-demand pull (ensureComposeRegistry
// at deploy time, reconcile self-heal as the cold-start / rate-limit safety
// net above) replaces the pre-pull this task's spec draft (R11) originally
// called for. Spec amended in this same commit — see
// the compose-registry-deploy-design spec.
// ---------------------------------------------------------------------------
describe('R11 (Option B): no registry:2 pre-pull in cloud-init on any provider', () => {
  it('carbon/cloud-init/docker-ce-setup.yaml does not pre-pull registry:2', () => {
    const sharedYaml = read('carbon/cloud-init/docker-ce-setup.yaml');
    expect(sharedYaml).not.toContain('registry:2');
  });

  it('the DO compose user-data (spliced from the same shared cloud-init) does not pre-pull registry:2', () => {
    const sharedYaml = read('carbon/cloud-init/docker-ce-setup.yaml');
    const doUserData = renderDoUserData(sharedYaml);
    expect(doUserData).not.toContain('registry:2');
  });
});
