import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkPackageManagerVersion,
  detectPackageManager,
  getInstallCommand,
  getPackageManagerVersion,
  RECOMMENDED_VERSIONS,
} from '../../../src/create.js';

describe('detectPackageManager', () => {
  const originalEnv = { ...process.env };
  // detectPackageManager probes for lockfiles under the dir it is given.
  // Point it at an empty scratch dir so the repo's own lockfile can't answer
  // for us — that masked the default-detection assertions before the switch.
  let scratch: string;

  beforeEach(() => {
    delete process.env.npm_config_user_agent;
    scratch = mkdtempSync(join(tmpdir(), 'vc-detect-pm-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  describe('detection from npm_config_user_agent', () => {
    it('detects pnpm from npm_config_user_agent', () => {
      process.env.npm_config_user_agent = 'pnpm/8.6.0 npm/? node/v18.0.0';
      expect(detectPackageManager(scratch)).toBe('pnpm');
    });

    it('picks npm when running via npx (npm user agent)', () => {
      process.env.npm_config_user_agent = 'npm/9.6.0 node/v18.0.0';
      expect(detectPackageManager(scratch)).toBe('npm');
    });

    it('detects bun from npm_config_user_agent', () => {
      process.env.npm_config_user_agent = 'bun/1.0.0';
      expect(detectPackageManager(scratch)).toBe('bun');
    });
  });

  describe('detection from a lockfile in cwd', () => {
    it.each([
      ['pnpm-lock.yaml', 'pnpm'],
      ['bun.lock', 'bun'],
      ['package-lock.json', 'npm'],
    ])('detects %s → %s', (lockfile, expected) => {
      writeFileSync(join(scratch, lockfile), '');
      expect(detectPackageManager(scratch)).toBe(expected);
    });
  });

  it('defaults to npm when no detection', () => {
    // npm ships with Node, so it is the only fallback that is guaranteed
    // installed on a machine that could run `vibecarbon` at all.
    expect(detectPackageManager(scratch)).toBe('npm');
  });
});

describe('getInstallCommand', () => {
  it('returns npm install for npm', () => {
    expect(getInstallCommand('npm')).toBe('npm install');
  });

  it('returns pnpm install for pnpm', () => {
    expect(getInstallCommand('pnpm')).toBe('pnpm install --no-frozen-lockfile');
  });

  it('returns bun install for bun', () => {
    expect(getInstallCommand('bun')).toBe('bun install');
  });

  it('defaults to npm install for unknown package manager', () => {
    expect(getInstallCommand('unknown')).toBe('npm install');
  });
});

describe('getPackageManagerVersion', () => {
  it('returns version string with full semver format for npm', () => {
    const result = getPackageManagerVersion('npm');
    expect(result).toMatch(/^npm@\d+\.\d+\.\d+/);
  });

  it('returns version string with full semver format for pnpm', () => {
    const result = getPackageManagerVersion('pnpm');
    expect(result).toMatch(/^pnpm@\d+\.\d+\.\d+/);
  });

  it('returns version string with full semver format for bun', () => {
    const result = getPackageManagerVersion('bun');
    expect(result).toMatch(/^bun@\d+\.\d+\.\d+/);
  });

  it('defaults to npm version for unknown package manager', () => {
    const result = getPackageManagerVersion('unknown');
    expect(result).toMatch(/^npm@\d+\.\d+\.\d+/);
  });
});

describe('checkPackageManagerVersion', () => {
  it('returns current version for installed package managers', () => {
    const result = checkPackageManagerVersion('pnpm');
    expect(result.current).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns isOutdated false for current pnpm (9+)', () => {
    const result = checkPackageManagerVersion('pnpm');
    // pnpm 9+ should not be marked outdated
    expect(result.isOutdated).toBe(false);
  });

  it('returns null current for non-existent package manager', () => {
    const result = checkPackageManagerVersion('nonexistent-pm-xyz');
    expect(result.current).toBeNull();
    expect(result.isOutdated).toBe(false);
  });

  it('has recommended versions defined for all supported package managers', () => {
    expect(RECOMMENDED_VERSIONS.npm).toBeDefined();
    expect(RECOMMENDED_VERSIONS.pnpm).toBeDefined();
    expect(RECOMMENDED_VERSIONS.bun).toBeDefined();
  });
});
