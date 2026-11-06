/**
 * The n8n owner setup behaves one way, wherever the script ships from.
 *
 * Why. `vibecarbon add n8n` ships services/n8n/scripts/setup.sh, and the
 * template carries carbon/volumes/n8n/scripts/setup.sh. They drifted: one
 * inserted into a `role` column n8n 2.x no longer has, and its failed psql was
 * swallowed while the script logged success. The other hardcoded the bcrypt
 * hash of "changeme" in every deploy, production included.
 *
 * How. The two copies must be byte for byte equal. The real script then runs
 * against a fake psql: a failed psql must exit non-zero without logging
 * success, the hash comes from N8N_ADMIN_PASSWORD_HASH, and with none set each
 * run stores a different random value. Only the dev override supplies the
 * "changeme" hash, written with compose's `$$` escaping.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(__dirname, '../../..');
const read = (file: string) => readFileSync(join(REPO, file), 'utf-8');
const COPIES = ['services/n8n/scripts/setup.sh', 'carbon/volumes/n8n/scripts/setup.sh'];
const OVERRIDES = [
  'services/n8n/compose/docker-compose.override.yml',
  'carbon/docker-compose.n8n.override.yml',
];
const BASES = ['services/n8n/compose/docker-compose.yml', 'carbon/docker-compose.n8n.yml'];
const CHANGEME_HASH = '$2a$10$HuKPNCaZ0UnhGFhLC1wMZ.e.1dpHzQ4eY84AWxGVTINMGnzDx8awy';

type Service = { environment?: string[] };
const setupEnv = (file: string) =>
  (loadYaml(read(file)) as { services: Record<string, Service> }).services['n8n-setup']
    ?.environment ?? [];

describe('n8n owner setup, shipped copies', () => {
  it('the two scripts are byte for byte the same', () => {
    expect(read(COPIES[0])).toBe(read(COPIES[1]));
  });

  it('updates the skeleton owner by roleSlug and stops on the first SQL error', () => {
    for (const file of COPIES) {
      const script = read(file);
      expect(script, file).toContain('"roleSlug"');
      expect(script, file).not.toMatch(/\brole\b\)/);
      expect(script, file).toContain('ON_ERROR_STOP=1');
      expect(script, file).toContain('"lastActiveAt"');
      expect(script, file).not.toContain('$2a$');
    }
  });

  it('only the dev override supplies the changeme hash, with compose escaping', () => {
    for (const file of OVERRIDES) {
      const entry = setupEnv(file).find((e) => e.startsWith('N8N_ADMIN_PASSWORD_HASH='));
      expect(entry, file).toBeDefined();
      // Compose reads `$$` as a literal `$`.
      expect((entry as string).slice('N8N_ADMIN_PASSWORD_HASH='.length).replaceAll('$$', '$')).toBe(
        CHANGEME_HASH,
      );
    }
    for (const file of [...BASES, 'carbon/docker-compose.n8n.prod.yml']) {
      expect(read(file), file).not.toContain('N8N_ADMIN_PASSWORD_HASH');
    }
  });
});

describe('n8n owner setup, run against a fake psql', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A psql that sees the user table at once, then fails or records the hash it was given. */
  function run(env: Record<string, string>, failSetup: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'vctest-n8n-setup-'));
    dirs.push(dir);
    const seen = join(dir, 'seen');
    writeFileSync(
      join(dir, 'psql'),
      `#!/bin/sh
case "$*" in
  *-tAc*) echo 1; exit 0 ;;
esac
cat >/dev/null
${failSetup ? 'echo "ERROR: boom" >&2; exit 3' : `for a in "$@"; do case "$a" in hash=*) echo "\${a#hash=}" > "${seen}" ;; esac; done`}
`,
    );
    chmodSync(join(dir, 'psql'), 0o755);
    const result = spawnSync('bash', [join(REPO, COPIES[0])], {
      encoding: 'utf-8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        N8N_DB_PASSWORD: 'x',
        N8N_ADMIN_EMAIL: 'admin@example.com',
        ...env,
      },
    });
    let hash = '';
    try {
      hash = readFileSync(seen, 'utf-8').trim();
    } catch {}
    return { ...result, hash };
  }

  it('a failed psql exits non-zero and never logs success', () => {
    const r = run({}, true);
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain('owner setup complete');
  });

  it('stores the hash it is given', () => {
    const r = run({ N8N_ADMIN_PASSWORD_HASH: CHANGEME_HASH }, false);
    expect(r.status).toBe(0);
    expect(r.hash).toBe(CHANGEME_HASH);
    expect(r.stderr).toContain('owner setup complete');
  });

  it('with no hash, stores a different random value every run', () => {
    const a = run({}, false);
    const b = run({}, false);
    expect(a.status).toBe(0);
    expect(a.hash.length).toBeGreaterThanOrEqual(32);
    expect(a.hash).not.toBe(CHANGEME_HASH);
    expect(a.hash).not.toBe(b.hash);
  });
});
