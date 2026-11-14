import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseScratchProject,
  reapStaleLocalArtifacts,
  STALE_RUN_MAX_AGE_MS,
  STALE_TEMP_MAX_AGE_MS,
} from '../../e2e/utils/local-artifacts.js';

const HOUR = 3_600_000;
const NOW = 1_794_200_000_000;
const OLD_NAME = `testapp-k8s-${NOW - 13 * HOUR}-abc123`;
const YOUNG_NAME = `testapp-compose-${NOW - 2 * HOUR}-zzz999`;

/** A fake docker: canned listings, records every removal argv. */
function fakeDocker(images: string[], volumes: string[]) {
  const calls: string[][] = [];
  const docker = (argv: readonly string[]): string => {
    calls.push([...argv]);
    if (argv[0] === 'images') return images.join('\n');
    if (argv[0] === 'volume' && argv[1] === 'ls') return volumes.join('\n');
    return '';
  };
  return { docker, calls };
}

describe('parseScratchProject', () => {
  it('parses the project and its start time from every tag scheme', () => {
    expect(parseScratchProject('10.0.1.2:5000/testapp-k8s-1794105178279-9trgtn')).toEqual({
      projectName: 'testapp-k8s-1794105178279-9trgtn',
      createdAtMs: 1794105178279,
    });
    expect(parseScratchProject('vibecarbon-local/testapp-k8s-1794105178279-9trgtn')).toEqual({
      projectName: 'testapp-k8s-1794105178279-9trgtn',
      createdAtMs: 1794105178279,
    });
    expect(parseScratchProject('testapp-compose-ha-1793951307008-0l9pc4-app')).toEqual({
      projectName: 'testapp-compose-ha-1793951307008-0l9pc4',
      createdAtMs: 1793951307008,
    });
    expect(parseScratchProject('testapp-k8s-1794105178279-9trgtn_db_data')).toEqual({
      projectName: 'testapp-k8s-1794105178279-9trgtn',
      createdAtMs: 1794105178279,
    });
    expect(parseScratchProject('citest-k8s-ha-1794105178279-9trgtn-app')?.projectName).toBe(
      'citest-k8s-ha-1794105178279-9trgtn',
    );
  });

  it('returns null for names that are not a scratch project', () => {
    for (const ref of ['vctest-postgres', 'vibecarbon-app', 'testapp1_grafana_data']) {
      expect(parseScratchProject(ref)).toBeNull();
    }
  });
});

describe('reapStaleLocalArtifacts', () => {
  let root: string;
  let rigDir: string;
  let tmpRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stale-reap-'));
    rigDir = join(root, 'results');
    tmpRoot = join(root, 'tmp');
    mkdirSync(rigDir);
    mkdirSync(tmpRoot);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reaps a 13-hour-old run's images and volumes", async () => {
    const { docker, calls } = fakeDocker(
      [`10.0.1.1:5000/${OLD_NAME}:abc-1`, `${OLD_NAME}-app:local`, 'vctest-postgres:latest'],
      [`${OLD_NAME}_db_data`, 'testapp1_grafana_data'],
    );
    const r = await reapStaleLocalArtifacts('[t]', { now: NOW, rigDir, tmpRoot, docker });
    expect(r).toEqual({ images: 2, volumes: 1, tempDirs: 0 });
    expect(calls.filter((c) => c[0] === 'rmi')).toEqual([
      ['rmi', '-f', `10.0.1.1:5000/${OLD_NAME}:abc-1`, `${OLD_NAME}-app:local`],
    ]);
    expect(calls.filter((c) => c[0] === 'volume' && c[1] === 'rm')).toEqual([
      ['volume', 'rm', '-f', `${OLD_NAME}_db_data`],
    ]);
  });

  it('keeps a run younger than 12 hours (a concurrent run)', async () => {
    const { docker, calls } = fakeDocker([`${YOUNG_NAME}-app:local`], [`${YOUNG_NAME}_db_data`]);
    const r = await reapStaleLocalArtifacts('[t]', { now: NOW, rigDir, tmpRoot, docker });
    expect(r).toEqual({ images: 0, volumes: 0, tempDirs: 0 });
    expect(calls.some((c) => c[0] === 'rmi' || c[1] === 'rm')).toBe(false);
    expect(STALE_RUN_MAX_AGE_MS).toBe(43_200_000);
  });

  it("keeps a kept rig's images whatever their age", async () => {
    const { docker, calls } = fakeDocker([`${OLD_NAME}-app:local`], [`${OLD_NAME}_db_data`]);
    const r = await reapStaleLocalArtifacts('[t]', {
      now: NOW,
      rigDir,
      tmpRoot,
      docker,
      liveProjects: new Set([OLD_NAME]),
    });
    expect(r).toEqual({ images: 0, volumes: 0, tempDirs: 0 });
    expect(calls.some((c) => c[0] === 'rmi' || c[1] === 'rm')).toBe(false);
  });

  it('reads live projects from tests/results/.rig-*.json when none are passed', async () => {
    writeFileSync(
      join(rigDir, '.rig-hetzner-k8s.json'),
      JSON.stringify({ projectName: OLD_NAME, provider: 'hetzner' }),
    );
    writeFileSync(join(rigDir, '.rig-broken.json'), '{not json');
    const { docker, calls } = fakeDocker([`${OLD_NAME}-app:local`], [`${OLD_NAME}_db_data`]);
    const r = await reapStaleLocalArtifacts('[t]', { now: NOW, rigDir, tmpRoot, docker });
    expect(r).toEqual({ images: 0, volumes: 0, tempDirs: 0 });
    expect(calls.some((c) => c[0] === 'rmi' || c[1] === 'rm')).toBe(false);
  });

  it('removes vibecarbon-e2e-* temp dirs and ca-bundle files older than 7 days and keeps newer ones', async () => {
    const oldAt = (NOW - STALE_TEMP_MAX_AGE_MS - HOUR) / 1000;
    const newAt = (NOW - 2 * HOUR) / 1000;
    const oldDir = join(tmpRoot, 'vibecarbon-e2e-old');
    const newDir = join(tmpRoot, 'vibecarbon-e2e-new');
    const oldPem = join(tmpRoot, 'vibecarbon-e2e-ca-bundle-1-aa.pem');
    const newPem = join(tmpRoot, 'vibecarbon-e2e-ca-bundle-2-bb.pem');
    const other = join(tmpRoot, 'unrelated-old');
    for (const d of [oldDir, newDir, other]) mkdirSync(d);
    for (const f of [oldPem, newPem]) writeFileSync(f, 'x');
    utimesSync(oldDir, oldAt, oldAt);
    utimesSync(oldPem, oldAt, oldAt);
    utimesSync(other, oldAt, oldAt);
    utimesSync(newDir, newAt, newAt);
    utimesSync(newPem, newAt, newAt);
    const { docker } = fakeDocker([], []);
    const r = await reapStaleLocalArtifacts('[t]', { now: NOW, rigDir, tmpRoot, docker });
    expect(r.tempDirs).toBe(2);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(oldPem)).toBe(false);
    expect(existsSync(newDir)).toBe(true);
    expect(existsSync(newPem)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it('never throws when docker fails or a temp dir cannot be removed', async () => {
    const throwing = () => {
      throw new Error('docker down');
    };
    const r = await reapStaleLocalArtifacts('[t]', {
      now: NOW,
      rigDir: join(root, 'missing'),
      tmpRoot: join(root, 'also-missing'),
      docker: throwing,
    });
    expect(r).toEqual({ images: 0, volumes: 0, tempDirs: 0 });
  });
});
