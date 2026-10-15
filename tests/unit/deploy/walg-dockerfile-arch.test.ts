/**
 * Drift guards for the db image delivery chain:
 *   docker/wal-g/Dockerfile         — builds wal-g ONCE, static (CGO off), and
 *                                     publishes it as ghcr.io/hyperformant/wal-g
 *   docker/postgres-walg/Dockerfile — THE db image: official postgres Alpine,
 *                                     pg_cron compiled in a builder stage, wal-g
 *                                     copied in, baked postgresql.conf. Built
 *                                     once in CI and pulled by every mode.
 *
 * These tests pin the properties that keep backups and cron alive behind green
 * health checks — deploy only asserts archive_mode=on, never that wal-g runs:
 *   (a) the wal-g builder produces a STATIC binary (CGO_ENABLED=0), so there is
 *       no libc to match against the Alpine base;
 *   (b) the db image copies from the SAME pinned wal-g image and EXECUTES
 *       `wal-g --version` in-build, so an incompatible binary fails the build;
 *   (c) both db-image stages are FROM the identical digest-pinned postgres
 *       Alpine ref (pg_cron is compiled against that server's headers);
 *   (d) pg_cron comes from a pinned release tag with a verified checksum, and
 *       its toolchain never reaches the final stage;
 *   (e) versions stay in lockstep across the builder ARG, the db image, and
 *       src/lib/images.js's DB_IMAGE_TAG.
 * Plus a repo-wide sweep so a NEW Dockerfile can't reintroduce a pinned-arch
 * download unnoticed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DB_IMAGE_TAG } from '../../../src/lib/images.js';

const ROOT = process.cwd();

const WALG_VERSION = 'v3.0.9';
const WALG_IMAGE = `ghcr.io/hyperformant/wal-g:${WALG_VERSION.slice(1)}`;
// postgres:<major>.<minor>-alpine<alpine>, by multi-arch index digest.
const PG_BASE = 'postgres:17.11-alpine3.24';
const PG_BASE_DIGEST = 'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const PG_CRON_VERSION = '1.6.8';

const WALG_BUILDER = join('docker', 'wal-g', 'Dockerfile');
const DB_IMAGE_DOCKERFILE = join('docker', 'postgres-walg', 'Dockerfile');

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

describe('docker/wal-g/Dockerfile builds wal-g static (musl-safe)', () => {
  const dockerfile = readFileSync(join(ROOT, WALG_BUILDER), 'utf-8');
  const instructions = logicalInstructions(dockerfile);
  const buildLayer = instructions.find((i) => /^RUN\b/.test(i) && i.includes('go build')) ?? '';

  it('pins the wal-g version as an ARG', () => {
    expect(dockerfile).toMatch(new RegExp(`^ARG WALG_VERSION=${WALG_VERSION}\\s*$`, 'm'));
  });

  it('builds with CGO disabled — a static binary is the musl guard (replaces RCA 2026-05-30 glibc pin)', () => {
    expect(buildLayer).toContain('CGO_ENABLED=0');
  });

  it('sets GOEXPERIMENT=jsonv2 (wal-g 3.x imports encoding/json/v2)', () => {
    expect(dockerfile).toMatch(/GOEXPERIMENT=jsonv2/);
  });

  it('cross-compiles from TARGETARCH instead of hardcoding an arch', () => {
    expect(dockerfile).toMatch(/^ARG TARGETARCH\s*$/m);
    expect(buildLayer).toMatch(/GOARCH=\$\{?TARGETARCH\}?/);
  });

  it('EXECUTES the binary in-build so a broken build fails loudly', () => {
    // Must run in a TARGETPLATFORM stage (the build stage may have
    // cross-compiled on BUILDPLATFORM and cannot exec the result).
    const execLayer = instructions.find((i) => /^RUN\b/.test(i) && /wal-g --version/.test(i));
    expect(execLayer, 'no RUN layer executes wal-g --version').toBeTruthy();
  });
});

describe(`${DB_IMAGE_DOCKERFILE} is the one db image`, () => {
  const dockerfile = readFileSync(join(ROOT, DB_IMAGE_DOCKERFILE), 'utf-8');
  const instructions = logicalInstructions(dockerfile);
  const froms = instructions.filter((i) => /^FROM\b/.test(i));
  const pgFroms = froms.filter((i) => !i.includes('hyperformant/wal-g'));
  // Final stage = everything after the last FROM.
  const lastFrom = instructions.findLastIndex((i) => /^FROM\b/.test(i));
  const finalStage = instructions.slice(lastFrom);

  it(`both postgres stages are FROM ${PG_BASE} pinned by the same digest`, () => {
    expect(pgFroms).toHaveLength(2);
    for (const from of pgFroms) {
      expect(from.split(/\s+/)[1]).toBe(`${PG_BASE}@${PG_BASE_DIGEST}`);
    }
  });

  it('pins pg_cron to a release tag and verifies the tarball checksum', () => {
    expect(dockerfile).toMatch(new RegExp(`^ARG PG_CRON_VERSION=${PG_CRON_VERSION}\\s*$`, 'm'));
    const add = instructions.find((i) => /^ADD\b/.test(i) && i.includes('citusdata/pg_cron'));
    expect(add, 'no ADD of the pg_cron release tarball').toBeTruthy();
    expect(add).toMatch(/--checksum=sha256:[0-9a-f]{64}\s/);
    // The URL interpolates the ARG, so the pinned tag above is the one fetched.
    expect(add).toContain(['/archive/refs/tags/v$', '{PG_CRON_VERSION}.tar.gz'].join(''));
  });

  it('the final stage installs no toolchain and copies only pg_cron files from the builder', () => {
    const finalText = finalStage.join('\n');
    expect(finalText).not.toMatch(/apk add|build-base|\bgcc\b|\bmake\b|clang|llvm/);
    const builderCopies = finalStage.filter((i) => /^COPY --from=pg_cron\b/.test(i));
    expect(builderCopies.map((i) => i.split(/\s+/)[2])).toEqual([
      '/out/usr/local/lib/postgresql/',
      '/out/usr/local/share/postgresql/extension/',
    ]);
  });

  it('bakes postgresql.conf at /etc/postgresql/postgresql.conf', () => {
    expect(finalStage).toContain('COPY postgresql.conf /etc/postgresql/postgresql.conf');
  });

  it(`COPYies wal-g from the pinned ${WALG_IMAGE} stage`, () => {
    expect(dockerfile).toContain(`FROM ${WALG_IMAGE} AS walg`);
    expect(
      finalStage.some((i) => /^COPY --from=walg\b/.test(i) && i.includes('/usr/local/bin/wal-g')),
    ).toBe(true);
  });

  it('EXECUTES wal-g --version so an incompatible binary fails the build, not the backups', () => {
    expect(finalStage.some((i) => /^RUN\b/.test(i) && /wal-g --version/.test(i))).toBe(true);
  });

  it('has no apt-get and no curl of upstream wal-g release assets', () => {
    expect(dockerfile).not.toMatch(/apt-get/);
    expect(dockerfile).not.toMatch(/wal-g\/wal-g\/releases/);
  });
});

describe('version lockstep across the delivery chain', () => {
  it('src/lib/images.js DB_IMAGE_TAG carries the same base version and wal-g version', () => {
    // Tag scheme: <PG_VERSION>-walg<WALG_VERSION> — e.g. 17.11-walg3.0.9.
    // Every mode pulls ghcr.io/hyperformant/postgres:<DB_IMAGE_TAG>, built from
    // docker/postgres-walg/Dockerfile, so the tag must describe that image.
    const pgVersion = PG_BASE.split(':')[1].replace(/-alpine.*$/, '');
    expect(DB_IMAGE_TAG).toBe(`${pgVersion}-walg${WALG_VERSION.slice(1)}`);
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
        join('docker', 'carbon-autoscaler', 'Dockerfile'),
        join('docker', 'postgres-walg', 'Dockerfile'),
        join('docker', 'wal-g', 'Dockerfile'),
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
