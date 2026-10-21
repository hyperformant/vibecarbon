/**
 * The Compose behaviour compose-ha's standby add-on hold rests on (primary-only
 * add-ons plan, Task 3): `up -d --scale <svc>=0` against the FULL file set
 * keeps a service at zero without touching the services it depends on.
 *
 *   - `up -d --scale b=0` never creates `b`, though `b` is in the file set;
 *   - on a running stack, `up -d --scale b=0` removes `b` and leaves `a`'s
 *     container id unchanged (no recreate of the dependency: on a node that is
 *     `db`, the serving primary's or the replica's);
 *   - the same through the rendered standby-scale.sh and STANDBY_SCALE_FLAG,
 *     the way reconcile.sh runs them, on a WALG_ROLE=standby .env, and a
 *     WALG_ROLE=primary .env brings `b` back without recreating `a`.
 *
 * Observed on Docker Compose v5.6.0 (2026-10-21).
 *
 * A throwaway two-service project (`a`, and `b` depending on `a`), each with
 * a container_name as every vibecarbon service has; only its own containers
 * and network are removed after.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  renderStandbyScaleScript,
  STANDBY_SCALE_FLAG,
  STANDBY_SCALE_SCRIPT,
} from '../../../src/lib/deploy/bundle.js';

const describeDocker = process.env.DOCKER_INTEGRATION === 'true' ? describe : describe.skip;

const PROJECT = `vc-scale0-${process.pid}`;
const A = `${PROJECT}-a`;
const B = `${PROJECT}-b`;

const COMPOSE = `services:
  a:
    image: alpine
    container_name: ${A}
    command: sleep 3600
    init: true
  b:
    image: alpine
    container_name: ${B}
    command: sleep 3600
    init: true
    depends_on:
      - a
`;

describeDocker(
  'compose --scale <svc>=0 holds a service at zero without touching its dependency',
  () => {
    let dir: string;
    const compose = (...args: string[]) =>
      execFileSync('docker', ['compose', '-p', PROJECT, '-f', 'docker-compose.yml', ...args], {
        cwd: dir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    /** The container's id, or '' when it does not exist. */
    const idOf = (name: string) =>
      execFileSync('docker', ['ps', '-aq', '--no-trunc', '--filter', `name=^${name}$`], {
        encoding: 'utf-8',
      }).trim();

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'vc-scale0-'));
      writeFileSync(join(dir, 'docker-compose.yml'), COMPOSE);
      writeFileSync(join(dir, STANDBY_SCALE_SCRIPT), renderStandbyScaleScript(['b']));
    });

    afterAll(() => {
      if (dir) {
        try {
          compose('down', '--remove-orphans', '-t', '0');
        } catch {
          /* nothing up */
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('up -d --scale b=0 never creates b', () => {
      compose('up', '-d', '--scale', 'b=0');
      expect(idOf(A)).not.toBe('');
      expect(idOf(B)).toBe('');
    });

    it('after a plain up, up -d --scale b=0 removes b and keeps a', () => {
      compose('up', '-d');
      const aId = idOf(A);
      expect(aId).not.toBe('');
      expect(idOf(B)).not.toBe('');
      compose('up', '-d', '--scale', 'b=0');
      expect(idOf(B)).toBe('');
      expect(idOf(A)).toBe(aId);
    });

    it('reconcile.sh shape: the fragment on a standby .env holds b at zero, a primary .env brings it back', () => {
      const up = () =>
        execFileSync(
          'bash',
          [
            '-c',
            `docker compose -p ${PROJECT} -f docker-compose.yml up -d --remove-orphans ${STANDBY_SCALE_FLAG}`,
          ],
          { cwd: dir, encoding: 'utf-8', stdio: 'pipe' },
        );
      compose('up', '-d');
      const aId = idOf(A);
      writeFileSync(join(dir, '.env'), 'WALG_ROLE=standby\n');
      up();
      expect(idOf(B)).toBe('');
      expect(idOf(A)).toBe(aId);
      writeFileSync(join(dir, '.env'), 'WALG_ROLE=primary\n');
      up();
      expect(idOf(B)).not.toBe('');
      expect(idOf(A)).toBe(aId);
    });
  },
);
