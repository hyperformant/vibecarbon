import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADDON_JOB_SCRIPT,
  ADDON_SERVICES_SCRIPT,
  ADDON_STATUS_FILE,
  addonWiresApp,
  backgroundAddonServices,
  backgroundAddons,
  parseAddonStatus,
  renderAddonJobScript,
  renderAddonServicesScript,
} from '../../../src/lib/services/addon-start.js';
import { declaredAddonNames, loadAddonStandby } from '../../../src/lib/services/standby-policy.js';

const REPO = join(import.meta.dirname, '..', '..', '..');

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
const servicesOf = (path: string): Record<string, any> =>
  // biome-ignore lint/suspicious/noExplicitAny: parsed YAML
  // Compose's merge tags (!reset, !override) only change how a value merges,
  // and {{PLACEHOLDERS}} are filled at create time; the service keys are what
  // this reads.
  ((
    loadYaml(
      readFileSync(path, 'utf8')
        .replace(/!(reset|override)\b[ \t]*/g, '')
        .replace(/\{\{[A-Z_]+\}\}/g, 'x'),
    ) as any
  )?.services ?? {}) as Record<string, any>;

const BASE_FILES = [
  'docker-compose.yml',
  'docker-compose.prod.yml',
  'docker-compose.dns01.prod.yml',
]
  .map((f) => join(REPO, 'carbon', f))
  .filter((p) => existsSync(p));
const BASE_SERVICES = new Set(BASE_FILES.flatMap((p) => Object.keys(servicesOf(p))));

/**
 * Census: every compose service a deployed server can run is classified.
 * Base-file services are core. Each add-on overlay service is either an
 * extension of a base service or declared in that add-on's manifest
 * (standby.compose services/setup), which is where the background job gets
 * its list. An unclassified service would start with the core stack and hold
 * the deploy, silently undoing the split.
 */
describe('every compose service is classified core or add-on', () => {
  for (const name of declaredAddonNames()) {
    it(`${name}: each overlay service extends a base service or is declared in its manifest`, () => {
      const { composeServices, composeSetup } = loadAddonStandby(name);
      const declared = new Set([...composeServices, ...composeSetup]);
      for (const f of ['docker-compose.yml', 'docker-compose.prod.yml']) {
        const p = join(REPO, 'services', name, 'compose', f);
        if (!existsSync(p)) continue;
        for (const svc of Object.keys(servicesOf(p))) {
          expect(
            BASE_SERVICES.has(svc) || declared.has(svc),
            `${name}/${f}: service "${svc}" is neither a base (core) service nor in the manifest's standby.compose`,
          ).toBe(true);
        }
      }
    });

    it(`${name}: wires-the-app reading matches a real YAML parse`, () => {
      const wired = ['docker-compose.yml', 'docker-compose.prod.yml'].some((f) => {
        const p = join(REPO, 'services', name, 'compose', f);
        return existsSync(p) && 'app' in servicesOf(p);
      });
      expect(addonWiresApp(name)).toBe(wired);
    });
  }

  it('no base (core) service is claimed by an add-on manifest', () => {
    for (const name of declaredAddonNames()) {
      const { composeServices, composeSetup } = loadAddonStandby(name);
      for (const svc of [...composeServices, ...composeSetup]) {
        expect(BASE_SERVICES.has(svc), `${name} claims core service ${svc}`).toBe(false);
      }
    }
  });

  it('the core includes what the app needs to serve', () => {
    for (const core of ['app', 'app-migrate', 'db', 'traefik']) {
      expect(BASE_SERVICES.has(core)).toBe(true);
    }
    expect(backgroundAddonServices(declaredAddonNames())).not.toEqual(
      expect.arrayContaining(['app', 'app-migrate', 'db', 'traefik']),
    );
  });
});

describe('backgroundAddons', () => {
  it('defers observability, n8n and metabase; keeps redis (the app is wired to it) in the core', () => {
    expect(addonWiresApp('redis')).toBe(true);
    const names = backgroundAddons(['observability', 'n8n', 'redis', 'metabase']).map(
      (a) => a.name,
    );
    expect(names).toEqual(['observability', 'n8n', 'metabase']);
    const n8n = backgroundAddons(['n8n'])[0];
    expect(n8n.services).toEqual(['n8n']);
    expect(n8n.setup).toEqual(['n8n-setup']);
  });

  it('nothing enabled: nothing deferred', () => {
    expect(backgroundAddons([])).toEqual([]);
    expect(backgroundAddonServices(['redis'])).toEqual([]);
  });
});

describe('parseAddonStatus', () => {
  it('reads the job file, dropping malformed lines', () => {
    expect(
      parseAddonStatus(
        'observability\trunning\t\nn8n\tfailed\tdid not become healthy: n8n exited 1\nbogus\nx\tweird\t\n',
      ),
    ).toEqual([
      { name: 'observability', state: 'running', reason: '' },
      { name: 'n8n', state: 'failed', reason: 'did not become healthy: n8n exited 1' },
    ]);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'vc-addon-job-'));
  dirs.push(d);
  return d;
}

describe('addon-services.sh', () => {
  const run = (env: string | null) => {
    const dir = tempDir();
    writeFileSync(join(dir, ADDON_SERVICES_SCRIPT), renderAddonServicesScript(['grafana', 'n8n']));
    if (env !== null) writeFileSync(join(dir, '.env'), env);
    return execFileSync('sh', [ADDON_SERVICES_SCRIPT], { cwd: dir, encoding: 'utf-8' });
  };
  it('lists the deferred services on a primary or single server', () => {
    expect(run(null)).toBe('grafana\nn8n\n');
    expect(run('WALG_ROLE=primary\n')).toBe('grafana\nn8n\n');
  });
  it('lists nothing on a compose-ha standby (whole-stack up, as today)', () => {
    expect(run('WALG_ROLE="standby"\n')).toBe('');
  });
});

/**
 * The job, run against a stub `docker` that logs every call and answers the
 * compose subcommands it uses. STUB_FAIL_UP / STUB_FAIL_PULL / STUB_SETUP_RC
 * drive the failure paths.
 */
function stubDocker(dir: string) {
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
if [ "$1" = wait ]; then echo "\${STUB_SETUP_RC:-0}"; exit 0; fi
shift # compose
while [ "$1" = "-f" ]; do shift 2; done
case "$1" in
  config) [ "$3" = app ] || [ "$3" = app-sidecar ] && echo 'demo-app:local' || echo "img/$3"; exit 0 ;;
  pull) [ -n "$STUB_FAIL_PULL" ] && { echo "toomanyrequests: rate limit"; exit 1; }; exit 0 ;;
  up)
    if [ -n "$STUB_HANG_UP" ]; then sleep 30; fi
    case "$*" in *--wait*) [ -n "$STUB_FAIL_UP" ] && { echo "container n8n exited (1)"; exit 1; } ;; esac
    exit 0 ;;
  ps) echo cid; exit 0 ;;
  logs) echo "n8n | Error: Mismatching encryption keys"; exit 0 ;;
esac
exit 0
`,
  );
  chmodSync(join(dir, 'docker'), 0o755);
}

function runJob(dir: string, env: Record<string, string> = {}) {
  writeFileSync(
    join(dir, ADDON_JOB_SCRIPT),
    renderAddonJobScript('demo', '-f docker-compose.yml', [
      { name: 'observability', services: ['grafana', 'loki'], setup: [] },
      { name: 'n8n', services: ['n8n'], setup: ['n8n-setup'] },
    ]),
  );
  stubDocker(dir);
  return spawnSync('sh', [ADDON_JOB_SCRIPT], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, VC_PROJECT_DIR: dir, ...env },
  });
}

/** Run a command without blocking the event loop, so node reaps the detached job it ends (a blocked parent leaves a zombie that still looks alive). */
function runAsync(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
  return new Promise<number | null>((resolve) => {
    const c = spawn(cmd, args, { ...opts, stdio: 'ignore' });
    c.on('exit', (code) => resolve(code));
  });
}
const status = (dir: string) =>
  parseAddonStatus(readFileSync(join(dir, ADDON_STATUS_FILE), 'utf8'));
const calls = (dir: string) => readFileSync(join(dir, 'calls'), 'utf8');

describe('addons-start.sh', () => {
  it('starts each add-on, runs its setup to completion, and records running', () => {
    const dir = tempDir();
    expect(runJob(dir).status).toBe(0);
    expect(status(dir)).toEqual([
      { name: 'observability', state: 'running', reason: '' },
      { name: 'n8n', state: 'running', reason: '' },
    ]);
    expect(calls(dir)).toMatch(
      /compose -f docker-compose\.yml up -d --no-deps --wait --wait-timeout 900 grafana loki/,
    );
    expect(calls(dir)).toMatch(/compose -f docker-compose\.yml up -d --no-deps n8n-setup/);
    expect(calls(dir)).toMatch(/^wait cid$/m);
    // The job leaves no pid behind once it is done.
    expect(existsSync(join(dir, '.vc-addons', 'job.pid'))).toBe(false);
  });

  it('never pulls the app image', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, ADDON_JOB_SCRIPT),
      renderAddonJobScript('demo', '-f a.yml', [
        { name: 'x', services: ['app-sidecar', 'grafana'], setup: [] },
      ]),
    );
    stubDocker(dir);
    spawnSync('sh', [ADDON_JOB_SCRIPT], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, VC_PROJECT_DIR: dir },
    });
    const pull =
      calls(dir)
        .split('\n')
        .find((l) => / pull /.test(l)) ?? '';
    expect(pull).toContain('grafana');
    expect(pull).not.toContain('app-sidecar');
  });

  it('a service that never gets healthy is failed, with the reason and its logs', () => {
    const dir = tempDir();
    runJob(dir, { STUB_FAIL_UP: '1' });
    const n8n = status(dir).find((a) => a.name === 'n8n');
    expect(n8n?.state).toBe('failed');
    expect(n8n?.reason).toMatch(/did not become healthy: container n8n exited \(1\)/);
    expect(readFileSync(join(dir, '.vc-addons', 'n8n.log'), 'utf8')).toContain(
      'Mismatching encryption keys',
    );
  });

  it('a failed pull is failed with the pull output', () => {
    const dir = tempDir();
    runJob(dir, { STUB_FAIL_PULL: '1' });
    expect(status(dir).every((a) => a.state === 'failed')).toBe(true);
    expect(status(dir)[0].reason).toMatch(/image pull failed: toomanyrequests/);
  });

  it('a setup that exits non-zero fails its add-on', () => {
    const dir = tempDir();
    runJob(dir, { STUB_SETUP_RC: '3' });
    const n8n = status(dir).find((a) => a.name === 'n8n');
    expect(n8n?.state).toBe('failed');
    expect(n8n?.reason).toMatch(/setup n8n-setup exited 3/);
  });

  it('a second run supersedes a first one still going (no duplicate jobs)', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, ADDON_JOB_SCRIPT),
      renderAddonJobScript('demo', '-f a.yml', [{ name: 'x', services: ['grafana'], setup: [] }]),
    );
    stubDocker(dir);
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, VC_PROJECT_DIR: dir };
    // The first job hangs inside `up`; detached so it leads its own group, as
    // setsid gives it on the server.
    const first = spawn('sh', [ADDON_JOB_SCRIPT], {
      cwd: dir,
      env: { ...env, STUB_HANG_UP: '1' },
      detached: true,
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((r) =>
      first.on('exit', (code, sig) => r(code ?? (sig ? -1 : null))),
    );
    for (let i = 0; i < 200 && !existsSync(join(dir, '.vc-addons', 'job.pid')); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await runAsync('sh', [ADDON_JOB_SCRIPT], { cwd: dir, env })).toBe(0);
    expect(await exited).not.toBe(0);
    expect(status(dir)).toEqual([{ name: 'x', state: 'running', reason: '' }]);
    expect(readdirSync(join(dir, '.vc-addons'))).not.toContain('job.pid');
  });
});

/**
 * C1: the job must never touch a core service. n8n and metabase declare
 * `depends_on: db`, so an `up` without --no-deps let compose recreate db from
 * the job's file set; and the job's file set was fixed at its start, before
 * compose-ha writes the replication overlay, so that db came back without it
 * (no 5433, a mid-deploy db restart).
 */
describe('addons-start.sh never touches the core stack', () => {
  it('every `up` it runs carries --no-deps', () => {
    const script = renderAddonJobScript('demo', '-f a.yml', [
      { name: 'n8n', services: ['n8n'], setup: ['n8n-setup'] },
    ]);
    const ups = script.split('\n').filter((l) => /\bdc up\b/.test(l));
    expect(ups.length).toBeGreaterThanOrEqual(2);
    for (const l of ups) expect(l, l).toMatch(/\bdc up -d --no-deps\b/);
  });

  it('resolves the replication overlay at each call, not once at job start', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, ADDON_JOB_SCRIPT),
      renderAddonJobScript('demo', '-f docker-compose.yml', [
        { name: 'n8n', services: ['n8n'], setup: [] },
      ]),
    );
    stubDocker(dir);
    // The overlay appears mid-job (compose-ha writes it after the core up).
    writeFileSync(
      join(dir, 'docker'),
      readFileSync(join(dir, 'docker'), 'utf8').replace(
        'echo "$*" >> ',
        `case "$*" in *pull*) touch "${dir}/docker-compose.replication.yml" ;; esac\necho "$*" >> `,
      ),
    );
    spawnSync('sh', [ADDON_JOB_SCRIPT], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, VC_PROJECT_DIR: dir },
    });
    const up =
      calls(dir)
        .split('\n')
        .find((l) => / up -d/.test(l)) ?? '';
    expect(up).toContain('-f docker-compose.replication.yml');
    expect(up).toMatch(/up -d --no-deps --wait/);
  });
});

/**
 * I-A3 / M-A4 / M-A6: `addons-start.sh stop` ends a running job (reconcile.sh
 * and the scale cutover run it before their own compose operations, so two
 * never run at once), and only ever kills a process that really is the job.
 */
describe('addons-start.sh stop', () => {
  const jobDir = () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, ADDON_JOB_SCRIPT),
      renderAddonJobScript('demo', '-f a.yml', [{ name: 'x', services: ['grafana'], setup: [] }]),
    );
    stubDocker(dir);
    return dir;
  };
  const env = (dir: string) => ({
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    VC_PROJECT_DIR: dir,
  });

  it('stops a running job and waits for it to be gone', async () => {
    const dir = jobDir();
    const first = spawn('sh', [ADDON_JOB_SCRIPT], {
      cwd: dir,
      env: { ...env(dir), STUB_HANG_UP: '1' },
      detached: true,
      stdio: 'ignore',
    });
    let exited = false;
    first.on('exit', () => {
      exited = true;
    });
    for (let i = 0; i < 200 && !existsSync(join(dir, '.vc-addons', 'job.pid')); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await runAsync('sh', [ADDON_JOB_SCRIPT, 'stop'], { cwd: dir, env: env(dir) })).toBe(0);
    await new Promise((res) => setTimeout(res, 50));
    expect(exited).toBe(true);
    // stop starts nothing: the only `up` is the first job's.
    const ups = readFileSync(join(dir, 'calls'), 'utf8')
      .split('\n')
      .filter((l) => / up -d/.test(l));
    expect(ups).toHaveLength(1);
  });

  it('never kills a pid that is not the job (a recycled pid)', async () => {
    const dir = jobDir();
    // A long-lived unrelated process owns the recorded pid.
    const other = spawn('sleep', ['5'], { stdio: 'ignore' });
    spawnSync('mkdir', ['-p', join(dir, '.vc-addons')]);
    writeFileSync(join(dir, '.vc-addons', 'job.pid'), `${other.pid}\n`);
    spawnSync('sh', [ADDON_JOB_SCRIPT, 'stop'], { cwd: dir, env: env(dir) });
    await new Promise((res) => setTimeout(res, 100));
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
    expect(other.killed).toBe(false);
    other.kill();
  });

  // Minor 3: a job that outlives the bounded wait (it ignores TERM, or a
  // compose child hangs) is KILLed, its whole verified group, before the pid
  // file is dropped: never a job still running with nothing recording it.
  it('escalates to KILL when the job outlives the wait', async () => {
    const dir = jobDir();
    // The job ignores TERM (inherited across exec), so only KILL ends it.
    const first = spawn('sh', ['-c', `trap '' TERM; exec sh ${ADDON_JOB_SCRIPT}`], {
      cwd: dir,
      env: { ...env(dir), STUB_HANG_UP: '1' },
      detached: true,
      stdio: 'ignore',
    });
    const exited = new Promise<string | null>((r) => first.on('exit', (_c, sig) => r(sig)));
    for (let i = 0; i < 200 && !existsSync(join(dir, '.vc-addons', 'job.pid')); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const code = await runAsync('sh', [ADDON_JOB_SCRIPT, 'stop'], {
      cwd: dir,
      env: { ...env(dir), VC_ADDON_STOP_WAIT: '1' },
    });
    expect(code).toBe(0);
    expect(await exited).toBe('SIGKILL');
    expect(existsSync(join(dir, '.vc-addons', 'job.pid'))).toBe(false);
  });

  it('with no job running, stop is a no-op that succeeds', () => {
    const dir = jobDir();
    expect(spawnSync('sh', [ADDON_JOB_SCRIPT, 'stop'], { cwd: dir, env: env(dir) }).status).toBe(0);
  });

  // Minor 1: the file names the attempt (deploy, scale or failover) that ran
  // the job, from VC_ATTEMPT_ID in the job's environment: never a clock.
  it('a run records the attempt id it was started for', () => {
    const dir = jobDir();
    spawnSync('sh', [ADDON_JOB_SCRIPT], {
      cwd: dir,
      env: { ...env(dir), VC_ATTEMPT_ID: 'a1b2c3d4e5f6' },
    });
    const text = readFileSync(join(dir, ADDON_STATUS_FILE), 'utf8');
    expect(text.split('\n')[0]).toBe('#attempt a1b2c3d4e5f6');
  });

  it('started with no attempt id: the file names none, so it never reads as current', () => {
    const dir = jobDir();
    const { VC_ATTEMPT_ID: _drop, ...rest } = env(dir);
    spawnSync('sh', [ADDON_JOB_SCRIPT], { cwd: dir, env: rest });
    expect(readFileSync(join(dir, ADDON_STATUS_FILE), 'utf8').split('\n')[0]).toBe('#attempt ');
  });
});

/**
 * I-A1: a compose-ha failover runs the same job on the promoted node, so its
 * status file is current. `promoted` mode skips the one-shot setups: the
 * replicated database already holds their work (the failover never runs them).
 */
describe('addons-start.sh promoted', () => {
  it('starts the add-ons, records them, and runs no setup', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, ADDON_JOB_SCRIPT),
      renderAddonJobScript('demo', '-f docker-compose.yml', [
        { name: 'n8n', services: ['n8n'], setup: ['n8n-setup'] },
      ]),
    );
    stubDocker(dir);
    spawnSync('sh', [ADDON_JOB_SCRIPT, 'promoted'], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, VC_PROJECT_DIR: dir },
    });
    expect(status(dir)).toEqual([{ name: 'n8n', state: 'running', reason: '' }]);
    expect(calls(dir)).not.toContain('n8n-setup');
    expect(calls(dir)).toMatch(/up -d --no-deps --wait .* n8n$/m);
  });
});
