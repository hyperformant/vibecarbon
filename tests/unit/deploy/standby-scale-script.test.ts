/**
 * compose-ha holds primary-only add-ons (n8n, metabase) at zero on a standby
 * (primary-only add-ons plan, Task 3). They write to the primary database, so
 * on a standby they would crash-loop on the read-only replica.
 *
 * The `-f` set never depends on role: a role-dependent file set would render
 * `db` differently on each node and recreate it (n8n's and metabase's overlays
 * both carry a `db:` key). Role-specific behaviour is only a runtime
 * `--scale <svc>=0` fragment, printed by `standby-scale.sh` from the node's own
 * `.env` (WALG_ROLE=standby), and appended to every whole-stack `up` the bundle
 * renders: reconcile.sh, the systemd ExecStart and the post-restore recreate.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  renderBundle,
  renderReconcileScript,
  renderStandbyScaleScript,
  renderSystemdUnit,
  STANDBY_SCALE_FLAG,
  STANDBY_SCALE_FLAG_SYSTEMD,
  STANDBY_SCALE_SCRIPT,
} from '../../../src/lib/deploy/bundle.js';
import { composeRoleEnv } from '../../../src/lib/deploy/walg-role.js';
import { formatDotenvLine } from '../../../src/lib/dotenv.js';
import { composeStandbyScaledServices } from '../../../src/lib/services/standby-policy.js';

const REPO = join(import.meta.dirname, '..', '..', '..');
const N8N_SCALED = composeStandbyScaledServices(['n8n']);
const FLAGS = '-f docker-compose.yml -f docker-compose.prod.yml';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-standby-scale-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run the rendered script the way reconcile.sh does: `sh standby-scale.sh` in the project dir. */
function runScript(services: string[], env: string | null): string {
  const dir = tempDir();
  writeFileSync(join(dir, STANDBY_SCALE_SCRIPT), renderStandbyScaleScript(services));
  if (env !== null) writeFileSync(join(dir, '.env'), env);
  return execFileSync('sh', [STANDBY_SCALE_SCRIPT], { cwd: dir, encoding: 'utf-8' });
}

describe('standby-scale.sh', () => {
  it('reads the services from the add-on declarations (n8n and its setup)', () => {
    expect(N8N_SCALED).toEqual(['n8n', 'n8n-setup']);
  });

  it('WALG_ROLE=standby prints one --scale <svc>=0 per service', () => {
    expect(runScript(N8N_SCALED, 'FOO=1\nWALG_ROLE=standby\n').trim()).toBe(
      '--scale n8n=0 --scale n8n-setup=0',
    );
  });

  it('accepts a double-quoted value', () => {
    expect(runScript(N8N_SCALED, 'WALG_ROLE="standby"\n').trim()).toBe(
      '--scale n8n=0 --scale n8n-setup=0',
    );
  });

  it('accepts a single-quoted value', () => {
    expect(runScript(N8N_SCALED, "WALG_ROLE='standby'\n").trim()).toBe(
      '--scale n8n=0 --scale n8n-setup=0',
    );
  });

  it('the last WALG_ROLE line wins', () => {
    expect(runScript(N8N_SCALED, 'WALG_ROLE=standby\nWALG_ROLE=primary\n')).toBe('');
    expect(runScript(N8N_SCALED, 'WALG_ROLE=primary\nWALG_ROLE=standby\n').trim()).toBe(
      '--scale n8n=0 --scale n8n-setup=0',
    );
  });

  it('WALG_ROLE=primary prints nothing', () => {
    expect(runScript(N8N_SCALED, 'WALG_ROLE=primary\n')).toBe('');
  });

  it('a .env without the key prints nothing', () => {
    expect(runScript(N8N_SCALED, 'FOO=standby\nNOT_WALG_ROLE=standby\n')).toBe('');
  });

  it('no .env prints nothing and exits 0', () => {
    expect(runScript(N8N_SCALED, null)).toBe('');
  });

  it('an empty service list prints nothing, even on a standby', () => {
    expect(runScript([], 'WALG_ROLE=standby\n')).toBe('');
  });

  it('reads the role the deploy writes (composeRoleEnv through formatDotenvLine)', () => {
    const envOf = (role: 'primary' | 'standby') =>
      Object.entries(composeRoleEnv(role))
        .map(([k, v]) => formatDotenvLine(k, v))
        .join('\n');
    expect(runScript(N8N_SCALED, `${envOf('standby')}\n`).trim()).toBe(
      '--scale n8n=0 --scale n8n-setup=0',
    );
    expect(runScript(N8N_SCALED, `${envOf('primary')}\n`)).toBe('');
  });
});

describe('the fragment rides every whole-stack up', () => {
  it('the fragment runs the script only when it is present', () => {
    expect(STANDBY_SCALE_SCRIPT).toBe('standby-scale.sh');
    expect(STANDBY_SCALE_FLAG).toBe('$([ -f standby-scale.sh ] && sh standby-scale.sh)');
    expect(STANDBY_SCALE_FLAG_SYSTEMD).toBe('$$([ -f standby-scale.sh ] && sh standby-scale.sh)');
  });

  it('reconcile.sh: the up line ends with the fragment; config and pull do not carry it', () => {
    const script = renderReconcileScript('myproj', FLAGS, false);
    const lines = script.split('\n');
    const up = lines.filter((l) => /^docker compose .* up -d/.test(l));
    expect(up).toHaveLength(1);
    // Then the core service list (empty without background add-ons, and on a
    // standby): reconcile-addons-background.test.ts.
    expect(up[0].endsWith(`up -d --remove-orphans ${STANDBY_SCALE_FLAG} $up_services`)).toBe(true);
    const config = lines.find((l) => /^docker compose .* config /.test(l));
    const pull = lines.find((l) => /^docker compose .* pull /.test(l));
    expect(config).toBeDefined();
    expect(pull).toBeDefined();
    expect(config).not.toContain(STANDBY_SCALE_SCRIPT);
    expect(pull).not.toContain(STANDBY_SCALE_SCRIPT);
  });

  it('systemd: ExecStart carries the $$ fragment, ExecStop does not', () => {
    const unit = renderSystemdUnit('myproj', FLAGS);
    const start = unit.split('\n').find((l) => l.startsWith('ExecStart='));
    const stop = unit.split('\n').find((l) => l.startsWith('ExecStop='));
    expect(start).toContain(`up -d --remove-orphans ${STANDBY_SCALE_FLAG_SYSTEMD}'`);
    expect(stop).not.toContain(STANDBY_SCALE_SCRIPT);
  });

  // Census: any `docker compose ... up -d` a whole-stack renderer emits must
  // carry the fragment, or that path brings n8n back up on a standby.
  it('every compose up -d in bundle.js and scale.js carries the fragment', () => {
    const offenders: string[] = [];
    for (const file of ['src/lib/deploy/bundle.js', 'src/scale.js']) {
      const lines = readFileSync(join(REPO, file), 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return;
        if (!/docker compose .*\bup -d\b/.test(line)) return;
        // The extraction sed program quotes the up line; it is not an invocation.
        if (line.includes('s/^docker compose')) return;
        if (!/STANDBY_SCALE_FLAG/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the census sees the invocations it guards (positive control)', () => {
    const scaleSrc = readFileSync(join(REPO, 'src/scale.js'), 'utf-8');
    expect(scaleSrc).toMatch(/docker compose .*up -d --force-recreate/);
  });
});

describe('renderBundle stages standby-scale.sh from the current options', () => {
  let cwd: string;
  afterEach(() => {
    if (cwd) process.chdir(cwd);
  });

  function stage(options: Record<string, unknown>) {
    cwd = process.cwd();
    const project = tempDir();
    writeFileSync(join(project, '.env'), 'FOO=1\n');
    process.chdir(project);
    const dir = renderBundle('myproj', options);
    dirs.push(dir);
    return dir;
  }

  it('with n8n and metabase on, the script lists both and their setups, executable', () => {
    const dir = stage({ n8n: true, metabase: true, redis: true, observability: true });
    const path = join(dir, STANDBY_SCALE_SCRIPT);
    expect(readFileSync(path, 'utf-8')).toBe(
      renderStandbyScaleScript(composeStandbyScaledServices(['n8n', 'metabase'])),
    );
    expect(statSync(path).mode & 0o777).toBe(0o755);
    writeFileSync(join(dir, '.env'), 'WALG_ROLE=standby\n');
    const out = execFileSync('sh', [STANDBY_SCALE_SCRIPT], { cwd: dir, encoding: 'utf-8' });
    expect(
      out
        .trim()
        .split(' ')
        .filter((t) => t !== '--scale'),
    ).toEqual(expect.arrayContaining(['n8n=0', 'n8n-setup=0', 'metabase=0', 'metabase-setup=0']));
    // with-app-tier add-ons follow the app tier: never scaled on the standby.
    expect(out).not.toMatch(/redis|prometheus|grafana/);
  });

  it('with n8n off, the script lists no n8n', () => {
    const dir = stage({ n8n: false, metabase: true });
    const script = readFileSync(join(dir, STANDBY_SCALE_SCRIPT), 'utf-8');
    expect(script).not.toContain('n8n');
    expect(script).toContain('metabase=0');
  });

  it('is written for every compose mode, a no-op with no add-ons', () => {
    const dir = stage({});
    expect(readFileSync(join(dir, STANDBY_SCALE_SCRIPT), 'utf-8')).toBe(
      renderStandbyScaleScript([]),
    );
  });
});
