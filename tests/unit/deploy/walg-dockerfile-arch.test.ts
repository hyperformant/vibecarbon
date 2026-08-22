/**
 * Drift guards for the two Dockerfiles that install the wal-g binary:
 * carbon/db/Dockerfile (built ON THE TARGET SERVER by the compose path,
 * `build: ./db`) and docker/postgres-walg/Dockerfile (pre-published multi-arch,
 * used by k8s).
 *
 * Both install a wal-g release asset whose name embeds an architecture. Because
 * supabase/postgres:15.8.1.085 is multi-arch, a hardcoded amd64 asset BUILDS
 * fine and the database comes up HEALTHY on an arm64 host — every wal-g exec
 * then fails, so WAL archiving and base backups are silently dead behind green
 * health checks. Deploy only asserts archive_mode=on, never that wal-g runs.
 *
 * These tests pin the two properties that remove that silent failure mode:
 *   (a) the asset is selected from TARGETARCH, not hardcoded;
 *   (b) the binary is EXECUTED (`wal-g --version`) in the same RUN layer as the
 *       download, so a wrong-arch or corrupt binary fails the build.
 * Plus a repo-wide sweep so a NEW Dockerfile can't reintroduce a pinned-arch
 * download unnoticed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const WALG_DOCKERFILES = [
  join('carbon', 'db', 'Dockerfile'),
  join('docker', 'postgres-walg', 'Dockerfile'),
];

// Dot-dirs are skipped wholesale (.git, .claude/worktrees — which would
// otherwise re-walk a whole copy of the repo — .turbo, …) alongside build and
// dependency output.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);

/** Every Dockerfile in the repo, as ROOT-relative paths. */
function findDockerfiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        findDockerfiles(join(dir, entry.name), out);
      }
    } else if (entry.name === 'Dockerfile' || entry.name.startsWith('Dockerfile.')) {
      out.push(relative(ROOT, join(dir, entry.name)));
    }
  }
  return out;
}

/**
 * Collapse backslash line-continuations so each returned string is one logical
 * Dockerfile instruction — that is exactly one image layer for RUN.
 */
function logicalInstructions(dockerfile: string): string[] {
  return dockerfile
    .replace(/\\\r?\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

describe.each(WALG_DOCKERFILES)('%s installs wal-g arch-correctly', (relPath) => {
  const dockerfile = readFileSync(join(ROOT, relPath), 'utf-8');
  const instructions = logicalInstructions(dockerfile);
  const installLayer =
    instructions.find((i) => /^RUN\b/.test(i) && i.includes('wal-g/wal-g')) ?? '';

  it('has a single RUN layer that downloads wal-g', () => {
    expect(installLayer, 'no RUN instruction downloads wal-g').not.toBe('');
  });

  it('declares ARG TARGETARCH (BuildKit predefined build arg)', () => {
    expect(dockerfile).toMatch(/^ARG TARGETARCH\s*$/m);
  });

  it('selects the release asset from TARGETARCH — amd64 and arm64 both handled', () => {
    expect(installLayer).toMatch(/case\s+"\$\{TARGETARCH\}"/);
    expect(installLayer).toContain('amd64) WALG_ASSET="wal-g-pg-ubuntu-20.04-amd64"');
    expect(installLayer).toContain('arm64) WALG_ASSET="wal-g-pg-ubuntu-20.04-aarch64"');
  });

  it('fails the build on an unset/unknown TARGETARCH instead of guessing', () => {
    expect(installLayer).toMatch(/unsupported TARGETARCH/);
    expect(installLayer).toMatch(/exit 1/);
  });

  it('never hardcodes an arch into the download URL', () => {
    // The URL must interpolate the resolved asset; a literal `-amd64.tar.gz`
    // (or `-aarch64.tar.gz`) is the exact bug this guards.
    expect(installLayer).toMatch(/\$\{WALG_ASSET\}\.tar\.gz/);
    expect(installLayer).not.toMatch(/releases\/download\/\S*(amd64|aarch64|arm64|x86_64)/);
  });

  it('EXECUTES the binary in the same RUN layer so a wrong-arch build fails loudly', () => {
    // Same-layer is load-bearing: a later RUN would still fail the build, but
    // splitting the check off invites it being dropped as "an extra layer".
    expect(installLayer).toMatch(/wal-g --version/);
    expect(installLayer.indexOf('--version')).toBeGreaterThan(installLayer.indexOf('curl'));
  });

  it('pins the ubuntu-20.04 build to match the base image glibc (RCA 2026-05-30)', () => {
    // supabase/postgres:15.8.1.085 is Ubuntu 20.04 (glibc 2.31) on BOTH arches;
    // the 22.04/24.04 builds die at runtime with `GLIBC_2.3x not found`.
    expect(installLayer).not.toMatch(/ubuntu-2[24]\.04/);
    expect(dockerfile).toMatch(/FROM supabase\/postgres:15\.8\.1\.085/);
  });
});

describe('repo-wide: no Dockerfile downloads a pinned-arch binary unverified', () => {
  const dockerfiles = findDockerfiles(ROOT).sort();

  it('knows about every Dockerfile in the repo', () => {
    // A new Dockerfile must be triaged here rather than silently escaping the
    // sweep below.
    expect(dockerfiles).toEqual(
      [
        join('carbon', 'Dockerfile'),
        join('carbon', 'db', 'Dockerfile'),
        join('docker', 'carbon-autoscaler', 'Dockerfile'),
        join('docker', 'postgres-walg', 'Dockerfile'),
      ].sort(),
    );
  });

  it.each(dockerfiles)('%s fetches no hardcoded-arch release asset', (relPath) => {
    const instructions = logicalInstructions(readFileSync(join(ROOT, relPath), 'utf-8'));
    const fetches = instructions.filter((i) => /^RUN\b/.test(i) && /\b(curl|wget)\b/.test(i));
    for (const layer of fetches) {
      // Downloads may mention an arch only via a TARGETARCH-resolved variable.
      const urls = [...layer.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
      for (const url of urls) {
        expect(url, `${relPath}: hardcoded arch in download URL`).not.toMatch(
          /amd64|aarch64|arm64|x86_64/,
        );
      }
    }
  });
});
