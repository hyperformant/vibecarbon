import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrphanStacks, listVibecarbonStacks } from '../../../src/lib/local-stacks.js';

// Proves the assumptions behind `vibecarbon up` pinning COMPOSE_PROJECT_NAME:
// with the name pinned in .env, renaming the folder and running compose again
// reuses the same volume and keeps the data.
const shouldRunDocker = process.env.DOCKER_INTEGRATION === 'true';
const describeDocker = shouldRunDocker ? describe : describe.skip;

const COMPOSE = `services:
  db:
    image: alpine
    container_name: rkv-db
    command: sleep 3600
    networks: [vibecarbon-network]
    volumes:
      - data:/data
networks:
  vibecarbon-network:
volumes:
  data:
`;

const docker = (args: string[], cwd?: string) =>
  execFileSync('docker', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });

describeDocker('renaming a project folder keeps its local volume', () => {
  let root: string;
  let a: string;
  let b: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rkv-'));
    a = join(root, 'a');
    b = join(root, 'b');
    mkdirSync(a);
    writeFileSync(join(a, 'docker-compose.yml'), COMPOSE);
    writeFileSync(join(a, '.env'), 'COMPOSE_PROJECT_NAME=rkv\n');
  });

  afterAll(() => {
    try {
      docker(['compose', '-p', 'rkv', 'down', '-v']);
    } catch {
      /* best effort */
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('adopts the stack after a rename without losing data', { timeout: 120_000 }, () => {
    docker(['compose', 'up', '-d'], a);
    docker(['exec', 'rkv-db', 'sh', '-c', 'echo kept > /data/marker']);

    renameSync(a, b);

    const orphans = findOrphanStacks(listVibecarbonStacks());
    expect(orphans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ project: 'rkv', reason: 'folder-missing' }),
      ]),
    );

    docker(['compose', 'up', '-d'], b);

    expect(docker(['exec', 'rkv-db', 'cat', '/data/marker']).trim()).toBe('kept');
    // Still one volume under the pinned name: no empty twin was created.
    expect(
      docker(['volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=rkv'])
        .trim()
        .split('\n'),
    ).toHaveLength(1);
    // NOTE: a plain `up -d` does not recreate an unchanged container, so its
    // working_dir label keeps pointing at the old folder (verified on this
    // docker/compose; the brief expected it to move to b/). The data survives
    // regardless, which is what the pin is for.
  });
});
