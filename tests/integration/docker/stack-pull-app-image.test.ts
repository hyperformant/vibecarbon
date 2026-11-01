/**
 * The stack pull, run for real: the command `pullComposeImages` sends to a
 * server (stackPullCommand) against real Docker Compose, on a project shaped
 * like the deploy's. app depends on app-migrate and db; app and app-migrate
 * run a local-only image no registry serves.
 *
 * DO e2e, 2026-11-01: every compose-ha deploy failed at pull-images with
 * `pull access denied for <project>-app`. #278 compared `config --images
 * <svc>` against app's, but that command also prints the images of the
 * service's dependencies, so nothing was ever excluded. Its unit test stubbed
 * one image per service and passed. This one asks compose itself.
 *
 *   - the pull exits 0: the app image is never asked of a registry (it does
 *     not exist locally, so a pull of it is `pull access denied`);
 *   - `pull` names exactly the other non-deferred services;
 *   - none of the deferred add-on services is pulled (their images do not
 *     exist anywhere, so pulling one would fail the command too).
 *
 * A throwaway project named `vctest-...`; nothing is started, and only its own
 * resources are removed after.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stackPullCommand } from '../../../src/lib/deploy/compose/index.js';
import {
  ADDON_SERVICES_SCRIPT,
  nonAppImageServicesShell,
  renderAddonServicesScript,
} from '../../../src/lib/services/addon-start.js';

const describeDocker = process.env.DOCKER_INTEGRATION === 'true' ? describe : describe.skip;

const PROJECT = `vctest-stackpull-${process.pid}`;
// Local-only, as on a server before (or while) the app image is built there.
const APP_IMAGE = `${PROJECT}-app:local`;
// Never published: a pull of either fails the whole command.
const DEFERRED_IMAGE = `${PROJECT}-addon:never-published`;
const BASE = 'alpine:3.21';

const COMPOSE = `name: ${PROJECT}
services:
  app:
    image: ${APP_IMAGE}
    pull_policy: never
    depends_on:
      app-migrate:
        condition: service_completed_successfully
      db:
        condition: service_healthy
  app-migrate:
    image: ${APP_IMAGE}
    pull_policy: never
    depends_on:
      db:
        condition: service_healthy
  db:
    image: ${BASE}
  traefik:
    image: ${BASE}
    depends_on:
      - app
  grafana:
    image: ${DEFERRED_IMAGE}
    depends_on:
      - db
  n8n:
    image: ${DEFERRED_IMAGE}
    depends_on:
      - db
`;

describeDocker('the stack pull against real compose skips the app image', () => {
  let dir: string;
  const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf-8' }).trim();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vctest-stackpull-'));
    writeFileSync(join(dir, 'docker-compose.yml'), COMPOSE);
    writeFileSync(join(dir, ADDON_SERVICES_SCRIPT), renderAddonServicesScript(['grafana', 'n8n']));
    // A shim in front of the real docker that records each call: real
    // compose answers and pulls, the test reads which services were named.
    const bin = join(dir, 'bin');
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/calls"\nexec "${realDocker}" "$@"\n`,
    );
    chmodSync(join(bin, 'docker'), 0o755);
    // The services that are pulled must be pullable; the base is tiny.
    execFileSync(realDocker, ['pull', '-q', BASE], { stdio: 'pipe' });
  }, 120_000);

  afterAll(() => {
    if (!dir) return;
    spawnSync(realDocker, ['compose', '-f', 'docker-compose.yml', 'down', '-v'], {
      cwd: dir,
      stdio: 'pipe',
    });
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (cmd: string) =>
    spawnSync('sh', ['-c', cmd], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    });

  it('compose itself lists app-migrate and app on the app image (the shape #278 missed)', () => {
    const r = run(`cd ${dir} && docker compose -f docker-compose.yml config --images app`);
    expect(r.status, r.stderr).toBe(0);
    // More than app's own image: its dependencies' images come with it.
    expect(r.stdout.trim().split('\n')).toContain(BASE);
  });

  it('nonAppImageServicesShell prints every service not on the app image', () => {
    const r = run(
      `cd ${dir} && ${nonAppImageServicesShell('docker compose -f docker-compose.yml')}`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n').sort()).toEqual(['db', 'grafana', 'n8n', 'traefik']);
  });

  it('pulls db and traefik only: never the app image, never a deferred add-on', () => {
    const calls = join(dir, 'calls');
    rmSync(calls, { force: true });
    const r = run(stackPullCommand(dir, '-f docker-compose.yml'));
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/pull access denied/);
    const pulls = (existsSync(calls) ? readFileSync(calls, 'utf-8') : '')
      .split('\n')
      .filter((l) => / pull /.test(l));
    expect(pulls).toHaveLength(1);
    const named = pulls[0]
      .replace(/^.* pull /, '')
      .split(' ')
      .filter((a) => a && !a.startsWith('--') && a !== 'missing')
      .sort();
    expect(named).toEqual(['db', 'traefik']);
  });
});
