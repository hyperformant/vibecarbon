/**
 * The app reads the host's restart state from `/host-status/state.json`, a file
 * the host reporter writes at `/run/vibecarbon-host/state.json`.
 *
 * Like the wal-g role bind (compose-role-bind.test.ts), the bind is the
 * DIRECTORY, read-only: the reporter replaces the file atomically (a new
 * inode), which a single-file bind would never see. No `Z`: the directory is
 * shared with the host, and relabelling it for one container is not ours to do.
 *
 * compose-ha runs the same two files (docker-compose.yml then
 * docker-compose.prod.yml, composeFileFlags) plus a replication overlay that
 * has no app service, so this one bind reaches both compose tiers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

// Compose's merge tags (`!reset`, `!override`) are not YAML core; drop them.
const load = (rel: string) =>
  loadYaml(readFileSync(join(ROOT, rel), 'utf-8').replace(/!(reset|override)\b/g, '')) as {
    services: Record<string, { volumes?: unknown[] }>;
  };

const COMPOSE_FILES = [
  'carbon/docker-compose.yml',
  'carbon/docker-compose.prod.yml',
  'carbon/docker-compose.override.yml',
  'carbon/docker-compose.n8n.yml',
  'carbon/docker-compose.n8n.prod.yml',
  'carbon/docker-compose.metabase.yml',
  'carbon/docker-compose.metabase.prod.yml',
];

describe('compose prod overlay: the host status bind', () => {
  it('the app gets the host state directory, read-only, with no Z', () => {
    expect(load('carbon/docker-compose.prod.yml').services.app.volumes).toEqual([
      '/run/vibecarbon-host:/host-status:ro',
    ]);
  });

  it('no service binds /run or /var/run as a whole', () => {
    for (const file of COMPOSE_FILES) {
      for (const [name, svc] of Object.entries(load(file).services)) {
        for (const v of svc.volumes ?? []) {
          const src = typeof v === 'string' ? v.split(':')[0] : (v as { source?: string }).source;
          expect(['/run', '/run/', '/var/run', '/var/run/'], `${file} ${name}`).not.toContain(src);
        }
      }
    }
  });

  it('the base file leaves the dev app without volumes', () => {
    expect(load('carbon/docker-compose.yml').services.app.volumes).toBeUndefined();
  });
});
