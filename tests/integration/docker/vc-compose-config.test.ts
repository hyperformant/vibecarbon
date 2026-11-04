/**
 * vc-compose against real Docker Compose: the bundle the deploy renders, run
 * through `sh vc-compose config` on the real carbon compose files.
 *
 * DO compose-ha scale, 2026-11-04: restoreCompose re-ran app-migrate as a bare
 * `docker compose run`, which read docker-compose.yml alone. There app-migrate
 * is a `build:` with no image, so compose tried to build on the server, where
 * there is no build context: `"/docker-entrypoint.sh": not found`. The prod
 * override gives it the deployed image and `build: !reset null`. Compose
 * itself answers here:
 *
 *   - through vc-compose, app-migrate is the deployed image and has no build;
 *   - the bare base file (the old call) has it as a build with no image;
 *   - a compose-ha node's replication overlay joins the set at run time.
 *
 * Only `config` runs: nothing is pulled, built or started, so no container,
 * network or volume is created.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderBundle } from '../../../src/lib/deploy/bundle.js';
import {
  COMPOSE_REPLICATION_OVERLAY,
  VC_COMPOSE,
} from '../../../src/lib/deploy/compose/command.js';
import { buildReplicationOverlay } from '../../../src/lib/deploy/compose/ha.js';
import { formatDotenvLine } from '../../../src/lib/dotenv.js';

const describeDocker = process.env.DOCKER_INTEGRATION === 'true' ? describe : describe.skip;

const ROOT = process.cwd();
const PROJECT = `vctest-vccompose-${process.pid}`;
const APP_IMAGE = `${PROJECT}-app:local`;

describeDocker('vc-compose renders the server stack, app-migrate included', () => {
  let project: string;
  let bundle: string;
  const cwd = process.cwd();

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), 'vctest-vccompose-project-'));
    // As `vibecarbon create` writes them: the generation-time placeholders filled.
    for (const f of ['docker-compose.yml', 'docker-compose.prod.yml']) {
      const text = readFileSync(join(ROOT, 'carbon', f), 'utf-8')
        .replaceAll('{{PROJECT_NAME}}', PROJECT)
        .replaceAll('{{GITHUB_OWNER}}', 'vctest-owner')
        .replaceAll('{{ADMIN_EMAIL}}', 'admin@example.com');
      writeFileSync(join(project, f), text);
    }
    // The keys the prod set requires (`:?`), as `vibecarbon create` writes them.
    const env = {
      PROJECT_NAME: PROJECT,
      BETTER_AUTH_SECRET: 'a'.repeat(32),
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'admin-password',
      APP_DB_PASSWORD: 'app-db-password',
      POSTGRES_PASSWORD: 'postgres-password',
    };
    writeFileSync(
      join(project, '.env'),
      `${Object.entries(env)
        .map(([k, v]) => formatDotenvLine(k, v))
        .join('\n')}\n`,
    );
    process.chdir(project);
    try {
      bundle = renderBundle(PROJECT, { image: APP_IMAGE });
    } finally {
      process.chdir(cwd);
    }
  });

  afterAll(() => {
    for (const d of [project, bundle]) if (d) rmSync(d, { recursive: true, force: true });
  });

  const config = (cmd: string) => {
    const r = spawnSync('sh', ['-c', `cd "${bundle}" && ${cmd} config --format json`], {
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout).services as Record<string, Record<string, unknown>>;
  };

  it('through vc-compose, app-migrate is the deployed image with no build', () => {
    const migrate = config(VC_COMPOSE)['app-migrate'];
    expect(migrate.image).toBe(APP_IMAGE);
    expect(migrate.build).toBeUndefined();
  });

  it('the bare base file (the call that failed) has app-migrate as a build with no image', () => {
    const migrate = config('docker compose')['app-migrate'];
    expect(migrate.build).toBeDefined();
    expect(migrate.image).toBeUndefined();
  });

  it('a compose-ha node: the replication overlay joins the set at run time', () => {
    expect(Object.keys(config(VC_COMPOSE))).not.toContain('repl-gateway');
    writeFileSync(join(bundle, COMPOSE_REPLICATION_OVERLAY), buildReplicationOverlay('10.99.0.1'));
    try {
      const services = config(VC_COMPOSE);
      expect(Object.keys(services)).toContain('repl-gateway');
      expect(JSON.stringify(services.db.ports)).toContain('5433');
      expect(services['app-migrate'].image).toBe(APP_IMAGE);
    } finally {
      rmSync(join(bundle, COMPOSE_REPLICATION_OVERLAY), { force: true });
    }
  });

  it('sanity: compose is the real one', () => {
    expect(execFileSync('docker', ['compose', 'version'], { encoding: 'utf-8' })).toMatch(
      /Docker Compose/,
    );
  });
});
