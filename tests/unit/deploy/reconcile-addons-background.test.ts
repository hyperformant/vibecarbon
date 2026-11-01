import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RECONCILE_FLAGS_SED, renderReconcileScript } from '../../../src/lib/deploy/bundle.js';
import {
  ADDON_JOB_SCRIPT,
  ADDON_SERVICES_SCRIPT,
  renderAddonServicesScript,
} from '../../../src/lib/services/addon-start.js';

/**
 * reconcile.sh brings up the core stack only and hands the add-ons to the
 * background job (services/addon-start.js), so the deploy's `compose up` and
 * its health waits never wait for observability, n8n or metabase. Run here
 * against a stub `docker` that answers `config --services` and logs every
 * call; the job is a stub that leaves a marker.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function reconcile({
  deferred,
  env,
  isFast = true,
  status,
}: {
  deferred: string[];
  env?: string;
  isFast?: boolean;
  status?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-reconcile-addons-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'reconcile.sh'), renderReconcileScript('demo', '-f a.yml', isFast));
  writeFileSync(join(dir, ADDON_SERVICES_SCRIPT), renderAddonServicesScript(deferred));
  writeFileSync(
    join(dir, ADDON_JOB_SCRIPT),
    `#!/bin/sh\nif [ "$1" = stop ]; then echo "job-stop" >> "${dir}/calls"; exit 0; fi\necho "started $VC_ATTEMPT_ID" > "${dir}/job-started"\n`,
  );
  if (status) {
    spawnSync('mkdir', ['-p', join(dir, '.vc-addons')]);
    writeFileSync(join(dir, '.vc-addons', 'status'), status);
  }
  if (env) writeFileSync(join(dir, '.env'), env);
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/sh
case "$*" in
  *"config --services"*) printf '%s\\n' app app-migrate db traefik grafana loki n8n n8n-setup ;;
  ps*|inspect*|"network ls"*) ;;
  *) echo "$*" >> "${dir}/calls" ;;
esac
exit 0
`,
  );
  chmodSync(join(dir, 'docker'), 0o755);
  const r = spawnSync('bash', ['reconcile.sh'], {
    cwd: dir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      VC_PROJECT_DIR: dir,
      VC_ATTEMPT_ID: 'a1b2c3d4e5f6',
    },
  });
  const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '';
  return { r, dir, calls };
}

async function jobStarted(dir: string) {
  for (let i = 0; i < 200; i++) {
    if (existsSync(join(dir, 'job-started'))) return true;
    await new Promise((res) => setTimeout(res, 10));
  }
  return false;
}

describe('reconcile.sh: core first, add-ons in the background', () => {
  it('ups only the core services, then starts the add-on job detached', async () => {
    const { r, dir, calls } = reconcile({ deferred: ['grafana', 'loki', 'n8n', 'n8n-setup'] });
    expect(r.status).toBe(0);
    const up = calls.split('\n').find((l) => l.includes(' up -d')) ?? '';
    expect(up).toMatch(/up -d --remove-orphans\s+app app-migrate db traefik\s*$/);
    expect(up).not.toMatch(/grafana|loki|n8n/);
    expect(r.stdout).toContain('Starting add-ons in the background');
    expect(await jobStarted(dir)).toBe(true);
  });

  // Minor 1: the job inherits the attempt id reconcile.sh was run with.
  it('the job is started with the attempt id from the ssh command', async () => {
    const { dir } = reconcile({ deferred: ['grafana'] });
    expect(await jobStarted(dir)).toBe(true);
    expect(readFileSync(join(dir, 'job-started'), 'utf8').trim()).toBe('started a1b2c3d4e5f6');
  });

  it('the image pull (non-local image) also covers the core only', async () => {
    const { calls, dir } = reconcile({ deferred: ['grafana'], isFast: false });
    await jobStarted(dir);
    const pull = calls.split('\n').find((l) => l.includes(' pull ')) ?? '';
    expect(pull).toContain('app app-migrate db traefik loki n8n n8n-setup');
    expect(pull).not.toContain('grafana');
  });

  it('no background add-ons: one whole-stack up, no job (unchanged)', async () => {
    const { r, dir, calls } = reconcile({ deferred: [] });
    expect(r.status).toBe(0);
    const up = calls.split('\n').find((l) => l.includes(' up -d')) ?? '';
    expect(up).toMatch(/up -d --remove-orphans\s*$/);
    await new Promise((res) => setTimeout(res, 50));
    expect(existsSync(join(dir, 'job-started'))).toBe(false);
  });

  it('a compose-ha standby keeps its whole-stack up (primary-only add-ons held by standby-scale.sh)', async () => {
    const { calls, dir } = reconcile({ deferred: ['grafana', 'n8n'], env: 'WALG_ROLE=standby\n' });
    const up = calls.split('\n').find((l) => l.includes(' up -d')) ?? '';
    expect(up).toMatch(/up -d --remove-orphans\s*$/);
    await new Promise((res) => setTimeout(res, 50));
    expect(existsSync(join(dir, 'job-started'))).toBe(false);
  });

  // I-A3: the previous deploy's add-on job is stopped before this deploy's
  // pull and core up, so two compose operations never run at once.
  it('stops the previous add-on job before the pull and the core up', async () => {
    const { calls, dir } = reconcile({ deferred: ['grafana'], isFast: false });
    await jobStarted(dir); // the detached job settles before the dir is removed
    const lines = calls.split('\n');
    const stop = lines.indexOf('job-stop');
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(lines.findIndex((l) => l.includes(' pull ')));
    expect(stop).toBeLessThan(lines.findIndex((l) => l.includes(' up -d')));
  });

  // Minor 4: the stop comes before ANY container change, the removed-network
  // sweep's `docker rm -f` included.
  it('stops the add-on job before the removed-network sweep', () => {
    const script = renderReconcileScript('demo', '-f a.yml', true);
    const stop = script.indexOf('sh addons-start.sh stop');
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(script.indexOf('docker rm -f'));
    expect(stop).toBeLessThan(
      script.indexOf('Checking for containers attached to removed networks'),
    );
  });

  // I-A1: a node that runs no job (a compose-ha standby, or no background
  // add-on) keeps no status file a reader could take for current.
  it('a node that starts no job removes any old add-on status file', () => {
    const { dir } = reconcile({
      deferred: ['grafana'],
      env: 'WALG_ROLE=standby\n',
      status: '#attempt a1b2c3d4e5f6\nobservability\trunning\t\n',
    });
    expect(existsSync(join(dir, '.vc-addons', 'status'))).toBe(false);
  });

  it('the up line still yields the baked -f set to RECONCILE_FLAGS_SED', () => {
    const script = renderReconcileScript('demo', '-f a.yml -f b.yml', true);
    const r = spawnSync('sed', ['-n', RECONCILE_FLAGS_SED], { input: script, encoding: 'utf-8' });
    expect(r.stdout.trim().split('\n').pop()).toBe('-f a.yml -f b.yml');
  });
});
