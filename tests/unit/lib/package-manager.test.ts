/**
 * Tests for src/lib/package-manager.js::adaptDockerfileForPackageManager.
 *
 * The template is npm-based (decision 2026-07-30), so npm is the no-op path
 * and pnpm/bun are the ones that get rewritten:
 * - package-manager bootstrap layer (npm ships with node; pnpm/bun do not)
 * - lockfile name (package-lock.json → pnpm-lock.yaml / bun.lock)
 * - install / build commands
 * - BuildKit cache mount path (must point at the PM's actual store —
 *   without this, pnpm/bun projects pay full network cost on every install
 *   because the mount is still targeted at npm's cache path).
 *
 * The last describe block runs the adapter against the REAL carbon/Dockerfile.
 * The rewrites are string substitutions, so an edit to the template that moves
 * the anchors would silently turn the adapter into a no-op and ship a broken
 * `-pm pnpm` / `-pm bun` project.
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adaptDockerfileForPackageManager,
  ensureLockfile,
  LOCKFILE_NAMES,
  TEMPLATE_INSTALL_BLOCK,
} from '../../../src/lib/package-manager.js';

const REPO_ROOT = resolve(__dirname, '../../..');

const TEMPLATE = `# syntax=docker/dockerfile:1
ARG BASE_IMAGE=node:22-alpine3.23
FROM \${BASE_IMAGE} AS builder

WORKDIR /app

# Install dependencies first so the layer caches independently of source.
COPY package.json package-lock.json ./
${TEMPLATE_INSTALL_BLOCK}

COPY src/ ./src/
RUN npm run build:client
RUN npm run build:server
`;

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'vc-pkgmgr-test-'));
  writeFileSync(join(projectDir, 'Dockerfile'), TEMPLATE);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function read() {
  return readFileSync(join(projectDir, 'Dockerfile'), 'utf-8');
}

describe('adaptDockerfileForPackageManager', () => {
  describe('npm (no-op)', () => {
    it('leaves the Dockerfile unchanged', () => {
      adaptDockerfileForPackageManager(projectDir, 'npm');
      expect(read()).toBe(TEMPLATE);
    });
  });

  describe('pnpm', () => {
    beforeEach(() => adaptDockerfileForPackageManager(projectDir, 'pnpm'));

    it('inserts a pnpm bootstrap layer ahead of the install step', () => {
      const content = read();
      expect(content).toMatch(/RUN npm install -g pnpm@\d+\.\d+\.\d+/);
      // Must land before the install it enables, not after.
      expect(content.indexOf('npm install -g pnpm')).toBeLessThan(
        content.indexOf('pnpm install --frozen-lockfile'),
      );
    });

    it('rewrites the lockfile COPY to pnpm-lock.yaml + pnpm-workspace.yaml', () => {
      // pnpm-workspace.yaml carries the dependency-security overrides (pnpm 11
      // ignores the `pnpm` block in package.json). pnpm records the active
      // overrides in the lockfile, so if the file isn't in the build context
      // `--frozen-lockfile` fails — better than silently dropping the pins,
      // but it means the COPY has to include it.
      expect(read()).toContain('COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./');
      expect(read()).not.toContain('package-lock.json');
    });

    it('rewrites install commands to pnpm install --frozen-lockfile', () => {
      expect(read()).toContain('pnpm install --frozen-lockfile');
      expect(read()).not.toContain('npm ci');
    });

    it('rewrites build commands to pnpm build:*', () => {
      expect(read()).toContain('pnpm build:client');
      expect(read()).toContain('pnpm build:server');
    });

    it("points the BuildKit cache mount at pnpm's store", () => {
      const content = read();
      expect(content).toContain('--mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store');
      // No leftover npm cache mount (the silent-loss bug this test guards).
      expect(content).not.toContain('id=npm,target=/root/.npm');
    });

    it('keeps exactly one cache mount (no drift)', () => {
      const matches = read().match(/--mount=type=cache/g) ?? [];
      expect(matches.length).toBe(1);
    });

    it('is idempotent — upgrade re-applies it without stacking bootstrap layers', () => {
      adaptDockerfileForPackageManager(projectDir, 'pnpm');
      const matches = read().match(/npm install -g pnpm/g) ?? [];
      expect(matches.length).toBe(1);
    });
  });

  describe('bun', () => {
    beforeEach(() => adaptDockerfileForPackageManager(projectDir, 'bun'));

    it('inserts a bun bootstrap layer', () => {
      expect(read()).toMatch(/RUN npm install -g bun@\d+\.\d+\.\d+/);
    });

    it('rewrites the lockfile COPY to bun.lock', () => {
      expect(read()).toContain('COPY package.json bun.lock ./');
      expect(read()).not.toContain('package-lock.json');
    });

    it('rewrites install commands to bun install --frozen-lockfile', () => {
      expect(read()).toContain('bun install --frozen-lockfile');
      expect(read()).not.toContain('npm ci');
    });

    it('rewrites build commands to bun run build:*', () => {
      expect(read()).toContain('bun run build:client');
      expect(read()).toContain('bun run build:server');
    });

    it("points the BuildKit cache mount at bun's cache", () => {
      const content = read();
      expect(content).toContain('--mount=type=cache,id=bun,target=/root/.bun/install/cache');
      expect(content).not.toContain('id=npm,target=/root/.npm');
    });

    it('keeps exactly one cache mount (no drift)', () => {
      const matches = read().match(/--mount=type=cache/g) ?? [];
      expect(matches.length).toBe(1);
    });
  });

  // Drift guard: the adapter is pure string substitution against the real
  // template. If carbon/Dockerfile stops matching an anchor, the rewrite
  // silently no-ops and `-pm pnpm` ships a Dockerfile that COPYs a lockfile
  // the project doesn't have.
  describe('against the real carbon/Dockerfile', () => {
    beforeEach(() => {
      copyFileSync(join(REPO_ROOT, 'carbon', 'Dockerfile'), join(projectDir, 'Dockerfile'));
    });

    it('the template itself is npm-based', () => {
      const content = read();
      expect(content).toContain('COPY package.json package-lock.json ./');
      expect(content).toContain('--mount=type=cache,id=npm,target=/root/.npm');
      // No pnpm in an executed instruction. Comments may still name it — the
      // Node pin's docblock cites `pnpm node:sync`, which is root-repo tooling
      // that writes this file, not something the image build runs.
      const instructions = content
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
      expect(instructions).not.toContain('pnpm');
    });

    it('ships the exact install block the adapter swaps out', () => {
      // The swap is a literal string replace. If the template's install block
      // drifts by so much as a flag, the adapter silently leaves `npm ci ||
      // npm install` in a pnpm project's Dockerfile.
      expect(read()).toContain(TEMPLATE_INSTALL_BLOCK);
    });

    it.each(['pnpm', 'bun'] as const)('fully adapts for %s — no npm remnants', (pm) => {
      adaptDockerfileForPackageManager(projectDir, pm);
      const content = read();
      const lockfile = pm === 'pnpm' ? 'pnpm-lock.yaml' : 'bun.lock';
      const cacheTarget =
        pm === 'pnpm' ? '/root/.local/share/pnpm/store' : '/root/.bun/install/cache';

      expect(content).toContain(`RUN npm install -g ${pm}@`);
      expect(content).toContain(
        pm === 'pnpm'
          ? `COPY package.json ${lockfile} pnpm-workspace.yaml ./`
          : `COPY package.json ${lockfile} ./`,
      );
      expect(content).toContain(`--mount=type=cache,id=${pm},target=${cacheTarget}`);
      expect(content).toContain(`${pm === 'pnpm' ? 'pnpm' : 'bun run'} build:client`);
      expect(content).toContain(`${pm === 'pnpm' ? 'pnpm' : 'bun run'} build:server`);

      // Nothing may still reach for npm's lockfile, install, or cache — and
      // the `|| npm install` repair branch must be gone, not just the `npm ci`
      // half of it. pnpm/bun lockfiles are portable; a failure there is real.
      expect(content).not.toContain('package-lock.json');
      expect(content).not.toContain('npm ci');
      expect(content).not.toContain('npm install --no-audit');
      expect(content).not.toContain('id=npm,target=/root/.npm');
      expect(content).not.toContain('npm run build:');
    });
  });
});

/**
 * ensureLockfile is the deploy preflight that closes the create → deploy gap:
 * the generated Dockerfile does `COPY package.json <lockfile> ./` followed by a
 * strict `npm ci`, so a project with no lockfile dies at the COPY step with a
 * raw BuildKit error — on the cloud paths, after infrastructure exists.
 *
 * These tests pin the two properties that matter and cost nothing to hold:
 * the present-lockfile path must not shell out (it runs on every deploy), and
 * the names must stay in lockstep with what the Dockerfile actually COPYs.
 */
describe('ensureLockfile', () => {
  it('names the same lockfiles the Dockerfile adapter COPYs', () => {
    // Drift here means the preflight checks for — or generates — a file the
    // build never reads, which reintroduces the exact failure it prevents.
    expect(LOCKFILE_NAMES).toEqual({
      npm: 'package-lock.json',
      pnpm: 'pnpm-lock.yaml',
      bun: 'bun.lock',
    });
  });

  it('is a no-op when the lockfile is already present (no install spawned)', () => {
    writeFileSync(join(projectDir, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
    writeFileSync(join(projectDir, 'package-lock.json'), '{"lockfileVersion":3}\n');

    const steps: string[] = [];
    const result = ensureLockfile(projectDir, 'npm', { onStep: (m) => steps.push(m) });

    expect(result).toEqual({
      lockfile: 'package-lock.json',
      generated: false,
      accepted: true,
    });
    // onStep firing at all means it decided to generate — i.e. it would have
    // spawned a full `npm install` on a project that already had a lockfile.
    expect(steps).toEqual([]);
  });

  it('accepts a pre-1.2 binary bun.lockb as satisfying the build', () => {
    writeFileSync(join(projectDir, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
    writeFileSync(join(projectDir, 'bun.lockb'), 'binary');

    const steps: string[] = [];
    const result = ensureLockfile(projectDir, 'bun', { onStep: (m) => steps.push(m) });

    expect(result).toEqual({ lockfile: 'bun.lockb', generated: false, accepted: true });
    expect(steps).toEqual([]);
  });
});
