import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Escape-class guard: every FILE the core compose files bind-mount from
 * ./volumes/ must be (a) scaffolded by `vibecarbon create` and (b) shipped
 * to the server by the deploy bundle. A file missing from either list makes
 * Docker auto-create an empty DIRECTORY at the mount source — the service
 * then dies with "Is a directory".
 *
 * This class has now bitten THREE times: wal-archive.sh (postgres archive
 * exit 126, see create.js's comment), then pooler.sql AND pooler.exs
 * together (db init aborted before set-passwords → every db-connected
 * service crash-looped on SASL auth; supavisor cat-crash-looped — RCA: kept
 * compose rig e1, 2026-08-06). Grep-level, so it runs in the unit tier.
 */

const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

const composeSources = [
  ...read('carbon/docker-compose.yml').matchAll(/\.\/(volumes\/[A-Za-z0-9._/-]+)/g),
  ...read('carbon/docker-compose.prod.yml').matchAll(/\.\/(volumes\/[A-Za-z0-9._/-]+)/g),
].map((m) => m[1]);

// FILE mounts only (last path segment carries an extension). Directory
// mounts (e.g. ./volumes/traefik) are created wholesale by other paths.
const fileMounts = [...new Set(composeSources)].filter((p) =>
  /\.[a-z]+$/.test(p.split('/').at(-1) ?? ''),
);

describe('compose file bind-mount sources', () => {
  it('found the known mounts (sanity — regex still matches the compose files)', () => {
    expect(fileMounts.length).toBeGreaterThanOrEqual(9);
    expect(fileMounts).toContain('volumes/db/pooler.sql');
    expect(fileMounts).toContain('volumes/pooler/pooler.exs');
  });

  it.each(fileMounts)('%s is scaffolded by create.js', (rel) => {
    const createSrc = read('src/create.js');
    // Must match the SOURCE argument position — `join(projectDir, '<rel>')`
    // destination args also contain the literal and must not satisfy this.
    const asCopySource = new RegExp(`copyTemplate\\(\\s*'${rel.replace(/[.]/g, '\\.')}'`);
    expect(
      asCopySource.test(createSrc),
      `${rel} is bind-mounted by a core compose file but create.js never copies it — ` +
        'the scaffold ships without it and Docker mounts an empty directory on the server.',
    ).toBe(true);
  });

  it.each([...new Set(fileMounts.map((p) => p.split('/').slice(0, 2).join('/')))])(
    '%s is shipped to the server by the deploy bundle',
    (dir) => {
      const bundleSrc = read('src/lib/deploy/bundle.js');
      expect(
        bundleSrc.includes(`'${dir}'`),
        `${dir} holds bind-mount sources but bundle.js never ships it — ` +
          'the server gets auto-created directories instead of the files.',
      ).toBe(true);
    },
  );

  it('template files exist for every file mount', () => {
    for (const rel of fileMounts) {
      expect(() => read(`carbon/${rel}`), `carbon/${rel} missing`).not.toThrow();
    }
  });
});

/**
 * Fourth member of the class (docker-compose.dev-init.yml, 2026-08-15):
 * create.js scaffolded the dev-repo-only generated overlay, whose
 * super-admin.generated.sql mount source is never scaffolded — Docker mounted
 * an auto-created directory over /tmp/super-admin.sql and db:migrate aborted
 * on the first `up` of every fresh project. Two guards close it:
 *
 * 1. The mount walk above only covered docker-compose.yml + prod.yml. Walk
 *    EVERY compose file create.js scaffolds: each of its ./volumes file
 *    mounts must itself be scaffolded.
 * 2. The bug shipped only from a dev checkout because the npm tarball
 *    excludes the file (copyTemplate silently skips missing sources) — a
 *    local create and a packaged create must not diverge, so no copyTemplate
 *    source may be excluded by carbon/.npmignore.
 */

const copyTemplateSources = [...read('src/create.js').matchAll(/copyTemplate\(\s*'([^']+)'/g)].map(
  (m) => m[1],
);

describe('compose files scaffolded by create.js', () => {
  const composeSources = copyTemplateSources.filter((p) => /^docker-compose[^/]*\.yml$/.test(p));

  it('found the compose copy list (sanity — regex still matches create.js)', () => {
    expect(composeSources).toContain('docker-compose.yml');
    expect(composeSources).toContain('docker-compose.override.yml');
  });

  it.each(composeSources)('every ./volumes file mount in %s is scaffolded', (compose) => {
    let content: string;
    try {
      content = read(`carbon/${compose}`);
    } catch {
      // Not present in this checkout (e.g. a gitignored generated file in
      // CI) — the .npmignore guard below still rejects scaffolding it.
      return;
    }
    const mounts = [...content.matchAll(/\.\/(volumes\/[A-Za-z0-9._/-]+)/g)]
      .map((m) => m[1])
      .filter((p) => /\.[a-z]+$/.test(p.split('/').at(-1) ?? ''));
    for (const rel of mounts) {
      expect(
        copyTemplateSources.includes(rel),
        `${compose} is scaffolded and bind-mounts ./${rel}, but create.js never copies ${rel} — ` +
          'Docker auto-creates a directory there and the service dies with "Is a directory".',
      ).toBe(true);
    }
  });
});

describe('create.js copy sources vs the npm tarball', () => {
  // Literal paths plus simple `*.ext`-style globs — the only pattern shapes
  // carbon/.npmignore currently uses for files.
  const npmignore = read('carbon/.npmignore')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const excludedBy = (src: string) =>
    npmignore.find((pat) => {
      if (pat === src || pat === `/${src}`) return true;
      if (pat.startsWith('*') && src.endsWith(pat.slice(1))) return true;
      return false;
    });

  it.each(copyTemplateSources)('%s is not excluded from the published template', (src) => {
    const pat = excludedBy(src);
    expect(
      pat === undefined,
      `create.js scaffolds ${src}, but carbon/.npmignore excludes it (pattern "${pat}") — ` +
        'a packaged create silently skips it while a dev-checkout create ships it, ' +
        'so the two scaffolds diverge (this is how docker-compose.dev-init.yml broke fresh projects).',
    ).toBe(true);
  });
});
