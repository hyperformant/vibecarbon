/**
 * Drift guards for the wal-g delivery chain:
 *   docker/wal-g/Dockerfile        — builds wal-g ONCE, static (CGO off), and
 *                                    publishes it as ghcr.io/hyperformant/wal-g
 *   carbon/db/Dockerfile           — compose path, built ON THE TARGET SERVER
 *                                    (`build: ./db`) and on dev machines
 *   docker/postgres-walg/Dockerfile — k8s path, pre-published
 *
 * History: through PG15 both consumers curled upstream's glibc release
 * tarballs, which required (RCA 2026-05-30) matching the wal-g build's glibc
 * to the base image's Ubuntu release, and (BUMP TRAP, 2026-07-30) tracking
 * upstream's asset renames. supabase/postgres 17.x is Alpine/musl + Nix, so
 * both hazards are retired the same way: ONE static build (no libc to match)
 * from a pinned source tag (no release assets to rename), executed in-build.
 *
 * These tests pin the properties that keep backups alive behind green health
 * checks — deploy only asserts archive_mode=on, never that wal-g runs:
 *   (a) the builder produces a STATIC binary (CGO_ENABLED=0) — the musl guard;
 *   (b) both consumers copy from the SAME pinned wal-g image and EXECUTE
 *       `wal-g --version` in-build, so an incompatible binary fails the build;
 *   (c) versions stay in lockstep across the builder ARG, both consumers, and
 *       src/lib/images.js's DB_IMAGE_TAG suffix.
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
const PG_BASE = 'supabase/postgres:17.6.1.167';

const WALG_BUILDER = join('docker', 'wal-g', 'Dockerfile');
const WALG_CONSUMERS = [
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

describe.each(WALG_CONSUMERS)('%s takes wal-g from the published static image', (relPath) => {
  const dockerfile = readFileSync(join(ROOT, relPath), 'utf-8');
  const instructions = logicalInstructions(dockerfile);

  it(`is FROM ${PG_BASE} (Alpine/Nix base) by digest`, () => {
    // Full regex-metachar escape (CodeQL js/incomplete-sanitization flagged
    // the earlier dot/slash-only version — moot for this constant input, but
    // complete is complete).
    const pgBaseLiteral = PG_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(dockerfile).toMatch(new RegExp(`^FROM ${pgBaseLiteral}@sha256:[0-9a-f]{64}`, 'm'));
  });

  it(`COPYies the binary from the pinned ${WALG_IMAGE} stage`, () => {
    expect(dockerfile).toContain(`FROM ${WALG_IMAGE}`);
    expect(
      instructions.some((i) => /^COPY --from=walg\b/.test(i) && i.includes('/usr/local/bin/wal-g')),
    ).toBe(true);
  });

  it('EXECUTES wal-g --version so an incompatible binary fails the build, not the backups', () => {
    expect(instructions.some((i) => /^RUN\b/.test(i) && /wal-g --version/.test(i))).toBe(true);
  });

  it('has no apt-get and no curl of upstream release assets (Alpine base; BUMP TRAP retired)', () => {
    expect(dockerfile).not.toMatch(/apt-get/);
    expect(dockerfile).not.toMatch(/wal-g\/wal-g\/releases/);
  });
});

describe('version lockstep across the delivery chain', () => {
  it('src/lib/images.js DB_IMAGE_TAG carries the same base version and wal-g version', () => {
    // Tag scheme: <PG_VERSION>-walg<WALG_VERSION> — e.g. 17.6.1.167-walg3.0.9.
    // k8s pulls ghcr.io/hyperformant/postgres:<DB_IMAGE_TAG>, built from
    // docker/postgres-walg/Dockerfile, so the tag must describe that image.
    const pgVersion = PG_BASE.split(':')[1];
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
        join('carbon', 'db', 'Dockerfile'),
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
