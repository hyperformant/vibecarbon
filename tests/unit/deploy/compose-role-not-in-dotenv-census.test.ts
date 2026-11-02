/**
 * Census: the wal-g role never comes back to `.env` (or to any env var).
 *
 * The role used to be `WALG_ROLE` in each compose node's `.env`, which only
 * reached the db container when it was recreated, so every role move
 * restarted the database. It is now one file per node,
 * `/opt/<project>/.vibecarbon-role/walg-role` (k8s: the role subPath of the
 * db volume), written only through walg-role.js and read only through its one
 * parser (D4: no alias, no compat). A `WALG_ROLE` key, expansion, printenv or
 * sed read anywhere in the shipped code would revive the old path, so the bare
 * token is banned from src/ and carbon/ altogether: code, comments and
 * templates. `VC_WALG_ROLE`, `WALG_ROLE_FILE` and the like are different
 * tokens and stay.
 *
 * An existing `.env` line on a deployed node is inert: nothing reads it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '../../..');

const shipped = spawnSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'carbon'],
  { cwd: REPO, encoding: 'utf-8' },
)
  .stdout.split('\n')
  .filter(Boolean)
  .filter((f) => !/\.(png|jpe?g|gif|ico|webp|woff2?|ttf|lockb?)$/.test(f));

/** The bare token: not part of VC_WALG_ROLE, WALG_ROLE_FILE, WALG_ROLE_DIR, ... */
const BARE = /(?<![\w])WALG_ROLE(?![\w])/;

/** `file:line: text` for every line holding the bare token. */
function hits(files: Array<{ path: string; text: string }>): string[] {
  return files.flatMap(({ path, text }) =>
    text
      .split('\n')
      .map((l, i) => (BARE.test(l) ? `${path}:${i + 1}: ${l.trim()}` : null))
      .filter((x): x is string => x !== null),
  );
}

describe('census: the wal-g role is not an env var anywhere it ships', () => {
  it('no WALG_ROLE token in src/ or carbon/', () => {
    const files = shipped.map((path) => ({
      path,
      text: readFileSync(join(REPO, path), 'utf-8'),
    }));
    expect(files.length).toBeGreaterThan(100);
    expect(
      hits(files),
      'the wal-g role lives in the role file (walg-role.js); nothing writes or reads WALG_ROLE',
    ).toEqual([]);
  });

  it('nothing writes WALG_ROLE into a compose .env any more', () => {
    for (const f of [
      'src/lib/deploy/compose/ha.js',
      'src/lib/deploy/effects/compose-ha.js',
      'src/scale.js',
    ]) {
      expect(readFileSync(join(REPO, f), 'utf-8'), f).not.toMatch(/composeRoleEnv|\bWALG_ROLE\s*:/);
    }
  });

  it('bites: a .env merge key, an expansion, a printenv and a sed read are each caught', () => {
    const stray = [
      "  await mergeRemoteDotenv(ip, o, dir, { WALG_ROLE: 'standby' });",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolation text
      '      WALG_ROLE: ${WALG_ROLE:-primary}',
      'docker compose exec -T db printenv WALG_ROLE',
      "sed -n 's/^WALG_ROLE=//p' .env",
    ].join('\n');
    expect(hits([{ path: 'stray.js', text: stray }])).toHaveLength(4);
  });

  it('lets the role file names through', () => {
    const fine = [
      'VC_WALG_ROLE=""',
      'printf \'WALG_ROLE_FILE=%s\\n\' "$VC_WALG_ROLE"',
      'export const WALG_ROLE_DIR = "/var/lib/vibecarbon/role";',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion text
      'case "${VC_WALG_ROLE_INTENT:-}" in',
    ].join('\n');
    expect(hits([{ path: 'fine.js', text: fine }])).toEqual([]);
  });
});
