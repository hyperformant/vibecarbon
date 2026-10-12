import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releaseMovedStack } from '../../../src/lib/compose-project-name.js';
import { findOrphanStacks, listVibecarbonStacks } from '../../../src/lib/local-stacks.js';

// Proves the assumptions behind `vibecarbon up` pinning COMPOSE_PROJECT_NAME:
// with the name pinned in .env, renaming the folder and running compose again
// reuses the same volume, keeps the data, and the stack follows the new folder.
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

    // Same teardown `up` runs on adopt: containers go, volumes stay.
    expect(releaseMovedStack('rkv', { cwd: b })).toBe(true);
    docker(['compose', 'up', '-d'], b);

    expect(docker(['exec', 'rkv-db', 'cat', '/data/marker']).trim()).toBe('kept');
    const volumes = docker([
      'volume',
      'ls',
      '-q',
      '--filter',
      'label=com.docker.compose.project=rkv',
    ])
      .trim()
      .split('\n');
    expect(volumes).toHaveLength(1);
    const workingDir = docker([
      'inspect',
      '-f',
      '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}',
      'rkv-db',
    ]).trim();
    expect(workingDir).toBe(b);
    expect(findOrphanStacks(listVibecarbonStacks()).map((o) => o.project)).not.toContain('rkv');
  });
});
