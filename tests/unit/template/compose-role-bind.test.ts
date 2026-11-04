/**
 * The compose db reads its wal-g role from `/var/lib/vibecarbon/role/walg-role`,
 * a file the CLI writes on the HOST at `/opt/<project>/.vibecarbon-role/`
 * (composeWalgRoleWriteShell, src/lib/deploy/walg-role.js).
 *
 * The bind is the DIRECTORY, read-only. A single-file bind pins the inode the
 * container saw at start: the CLI's atomic write (`mv -f` of a temp file over
 * the role file) gives the role a new inode, which the container would never
 * see. `Z` relabels the host directory for the container on an SELinux host.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { COMPOSE_WALG_ROLE_HOST_DIR, WALG_ROLE_DIR } from '../../../src/lib/deploy/walg-role.js';

const ROOT = process.cwd();

// Compose's merge tags (`!reset`, `!override`) are not YAML core; drop them.
const load = (text: string) => loadYaml(text.replace(/!(reset|override)\b/g, ''));

type Doc = { services: Record<string, { volumes?: string[] }> };

describe('compose prod overlay: the wal-g role directory bind', () => {
  it('binds the role DIRECTORY read-only (a single-file bind pins the old inode across the rename)', () => {
    const prod = load(readFileSync(join(ROOT, 'carbon/docker-compose.prod.yml'), 'utf-8')) as Doc;
    expect(prod.services.db.volumes).toContain('./.vibecarbon-role:/var/lib/vibecarbon/role:ro,Z');
  });

  it('the bind agrees with the paths the CLI writes and the db reads', () => {
    expect(`./${COMPOSE_WALG_ROLE_HOST_DIR}:${WALG_ROLE_DIR}:ro,Z`).toBe(
      './.vibecarbon-role:/var/lib/vibecarbon/role:ro,Z',
    );
  });

  it('only the prod overlay binds it: local dev has no role writer', () => {
    const base = load(readFileSync(join(ROOT, 'carbon/docker-compose.yml'), 'utf-8')) as Doc;
    expect(base.services.db.volumes ?? []).not.toContainEqual(
      expect.stringContaining(COMPOSE_WALG_ROLE_HOST_DIR),
    );
  });
});
