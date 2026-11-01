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
}: {
  deferred: string[];
  env?: string;
  isFast?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-reconcile-addons-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'reconcile.sh'), renderReconcileScript('demo', '-f a.yml', isFast));
  writeFileSync(join(dir, ADDON_SERVICES_SCRIPT), renderAddonServicesScript(deferred));
  writeFileSync(join(dir, ADDON_JOB_SCRIPT), `#!/bin/sh\necho started > "${dir}/job-started"\n`);
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
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, VC_PROJECT_DIR: dir },
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

  it('the image pull (non-local image) also covers the core only', () => {
    const { calls } = reconcile({ deferred: ['grafana'], isFast: false });
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

  it('the up line still yields the baked -f set to RECONCILE_FLAGS_SED', () => {
    const script = renderReconcileScript('demo', '-f a.yml -f b.yml', true);
    const r = spawnSync('sed', ['-n', RECONCILE_FLAGS_SED], { input: script, encoding: 'utf-8' });
    expect(r.stdout.trim().split('\n').pop()).toBe('-f a.yml -f b.yml');
  });
});
