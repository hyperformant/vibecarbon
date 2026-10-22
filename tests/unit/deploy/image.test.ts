import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildLocalImage,
  generateLocalImageTag,
  inspectGitState,
  readRuntimeBaseRef,
} from '../../../src/lib/deploy/image.js';
import { PLATFORM_BUILD_FLAG } from '../../../src/lib/deploy/platform.js';
import { NODE_RUNTIME_IMAGE } from '../../../src/lib/images.js';

vi.mock('node:child_process', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

// buildLocalImage shells out via runCommandAsync (async seam)
// while inspectGitState stays on execFileSync (sync policy) — mock both.
vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    runCommandAsync: vi.fn().mockResolvedValue(true),
  };
});

const { runCommandAsync } = await import('../../../src/lib/command.js');

describe('generateLocalImageTag', () => {
  it('generates a clean-tree tag from project + sha + timestamp', () => {
    const tag = generateLocalImageTag({
      projectName: 'myproj',
      gitSha: 'abc1234',
      isDirty: false,
      timestamp: '20260425143000',
    });
    expect(tag).toBe('vibecarbon-local/myproj:abc1234-20260425143000');
  });

  it('marks dirty trees with -dirty in the tag', () => {
    const tag = generateLocalImageTag({
      projectName: 'myproj',
      gitSha: 'abc1234',
      isDirty: true,
      timestamp: '20260425143000',
    });
    expect(tag).toBe('vibecarbon-local/myproj:abc1234-dirty-20260425143000');
  });

  it('falls back to "nogit" sha when git is unavailable', () => {
    const tag = generateLocalImageTag({
      projectName: 'myproj',
      gitSha: 'nogit',
      isDirty: false,
      timestamp: '20260425143000',
    });
    expect(tag).toBe('vibecarbon-local/myproj:nogit-20260425143000');
  });

  it('preserves projectName with hyphens', () => {
    const tag = generateLocalImageTag({
      projectName: 'my-project',
      gitSha: 'abc1234',
      isDirty: false,
      timestamp: '20260425143000',
    });
    expect(tag).toBe('vibecarbon-local/my-project:abc1234-20260425143000');
  });

  it('honors a custom prefix when supplied (k8s-mode registry tag)', () => {
    // Phase 6 of k8s VPS autoscaling: k8s-mode passes the master's
    // local-registry hostport so the same tag is also a valid
    // registry-pull reference for CA-spawned workers.
    const tag = generateLocalImageTag({
      projectName: 'myproj',
      gitSha: 'abc1234',
      isDirty: false,
      timestamp: '20260425143000',
      prefix: '10.0.1.1:5000',
    });
    expect(tag).toBe('10.0.1.1:5000/myproj:abc1234-20260425143000');
  });

  it('preserves -dirty marker with a custom prefix', () => {
    const tag = generateLocalImageTag({
      projectName: 'myproj',
      gitSha: 'abc1234',
      isDirty: true,
      timestamp: '20260425143000',
      prefix: '10.0.1.1:5000',
    });
    expect(tag).toBe('10.0.1.1:5000/myproj:abc1234-dirty-20260425143000');
  });
});

describe('inspectGitState', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });
  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('returns short sha + clean for an unmodified working tree', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('abc1234\n').mockReturnValueOnce('');

    const result = inspectGitState('/some/dir');
    expect(result).toEqual({ gitSha: 'abc1234', isDirty: false });
  });

  it('marks the tree dirty when porcelain output is non-empty', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('abc1234\n').mockReturnValueOnce(' M src/foo.js\n');

    const result = inspectGitState('/some/dir');
    expect(result).toEqual({ gitSha: 'abc1234', isDirty: true });
  });

  it('falls back to {gitSha: "nogit", isDirty: false} when git rev-parse fails', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('fatal: not a git repository');
    });

    const result = inspectGitState('/some/dir');
    expect(result).toEqual({ gitSha: 'nogit', isDirty: false });
  });
});

describe('buildLocalImage', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(runCommandAsync).mockReset();
    vi.mocked(runCommandAsync).mockResolvedValue(true);
  });
  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(runCommandAsync).mockReset();
  });

  it('builds the image with a tag derived from git state and a fixed timestamp', async () => {
    vi.mocked(execFileSync).mockReturnValueOnce('abc1234\n').mockReturnValueOnce('');

    const result = await buildLocalImage('/p', {
      projectName: 'myproj',
      timestamp: '20260425143000',
    });

    expect(result).toEqual({
      tag: 'vibecarbon-local/myproj:abc1234-20260425143000',
      gitSha: 'abc1234',
      isDirty: false,
    });
    const buildCall = vi.mocked(runCommandAsync).mock.calls[0];
    expect(buildCall[0][0]).toBe('docker');
    expect(buildCall[0].slice(1)).toEqual([
      'build',
      '--platform=linux/amd64',
      '-t',
      'vibecarbon-local/myproj:abc1234-20260425143000',
      '/p',
    ]);
  });

  it('passes --no-cache to docker build when rebuild=true', async () => {
    vi.mocked(execFileSync).mockReturnValueOnce('abc1234\n').mockReturnValueOnce('');

    await buildLocalImage('/p', {
      projectName: 'myproj',
      timestamp: '20260425143000',
      rebuild: true,
    });

    const buildCall = vi.mocked(runCommandAsync).mock.calls[0];
    expect(buildCall[0]).toContain('--no-cache');
  });

  it('throws when docker build exits non-zero', async () => {
    vi.mocked(execFileSync).mockReturnValueOnce('abc1234\n').mockReturnValueOnce('');
    // Non-silent runCommandAsync resolves `false` on nonzero exit rather than
    // rejecting (see src/lib/command.js) — buildLocalImage must still fail
    // loudly rather than silently swallow it.
    vi.mocked(runCommandAsync).mockResolvedValueOnce(false);

    await expect(
      buildLocalImage('/p', { projectName: 'myproj', timestamp: '20260425143000' }),
    ).rejects.toThrow(/docker build failed/);
  });

  it('rethrows when the docker spawn itself errors (e.g. binary missing)', async () => {
    vi.mocked(execFileSync).mockReturnValueOnce('abc1234\n').mockReturnValueOnce('');
    vi.mocked(runCommandAsync).mockRejectedValueOnce(new Error('docker: command not found'));

    await expect(
      buildLocalImage('/p', { projectName: 'myproj', timestamp: '20260425143000' }),
    ).rejects.toThrow(/docker.*not found/);
  });

  it('generates a default UTC timestamp when none is supplied', async () => {
    vi.mocked(execFileSync).mockReturnValueOnce('abc1234\n').mockReturnValueOnce('');

    const result = await buildLocalImage('/p', { projectName: 'myproj' });
    expect(result.tag).toMatch(/^vibecarbon-local\/myproj:abc1234-\d{14}$/);
  });

  it('throws when projectName is missing', async () => {
    await expect(buildLocalImage('/p', {} as { projectName: string })).rejects.toThrow(
      /projectName is required/,
    );
  });

  it('uses tagPrefix when supplied (k8s-mode 10.0.1.1:5000 path)', async () => {
    vi.mocked(execFileSync).mockReturnValueOnce('abc1234\n').mockReturnValueOnce('');

    const result = await buildLocalImage('/p', {
      projectName: 'myproj',
      timestamp: '20260425143000',
      tagPrefix: '10.0.1.1:5000',
    });

    expect(result.tag).toBe('10.0.1.1:5000/myproj:abc1234-20260425143000');
    const buildCall = vi.mocked(runCommandAsync).mock.calls[0];
    expect(buildCall[0].slice(1)).toEqual([
      'build',
      '--platform=linux/amd64',
      '-t',
      '10.0.1.1:5000/myproj:abc1234-20260425143000',
      '/p',
    ]);
  });

  // vibecarbon is x86-64 only (src/lib/deploy/platform.js). This build runs on
  // the OPERATOR's machine, so without the pin the image inherits the
  // operator's architecture — an Apple Silicon operator silently shipped arm64
  // to an amd64 server. Pin it here on every path, including --no-cache and
  // build-arg permutations.
  it('always passes --platform=linux/amd64, whatever else is in the argv', async () => {
    for (const options of [
      { projectName: 'myproj', timestamp: '20260425143000' },
      { projectName: 'myproj', timestamp: '20260425143000', rebuild: true },
      {
        projectName: 'myproj',
        timestamp: '20260425143000',
        tagPrefix: '10.0.1.1:5000',
        buildArgs: { VITE_PUBLIC_URL: 'https://x.example' },
      },
    ]) {
      vi.mocked(runCommandAsync).mockClear();
      vi.mocked(execFileSync).mockReturnValueOnce('abc1234\n').mockReturnValueOnce('');
      await buildLocalImage('/p', options);
      const argv = vi.mocked(runCommandAsync).mock.calls[0][0] as string[];
      expect(argv).toContain(PLATFORM_BUILD_FLAG);
      expect(PLATFORM_BUILD_FLAG).toBe('--platform=linux/amd64');
      // Immediately after `build`, never after the context path.
      expect(argv.indexOf(PLATFORM_BUILD_FLAG)).toBeLessThan(argv.indexOf('-t'));
    }
  });

  it('failure message explains the amd64 pin (arm64 hosts need emulation)', async () => {
    vi.mocked(execFileSync).mockReturnValueOnce('abc1234\n').mockReturnValueOnce('');
    vi.mocked(runCommandAsync).mockResolvedValueOnce(false);

    await expect(
      buildLocalImage('/p', { projectName: 'myproj', timestamp: '20260425143000' }),
    ).rejects.toThrow(/linux\/amd64.*x86-64 only/s);
  });
});

describe('readRuntimeBaseRef', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-base-ref-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the ARG RUNTIME_IMAGE default the image builds FROM', () => {
    writeFileSync(
      join(dir, 'Dockerfile'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG expansion
      'FROM node:24 AS build\nARG RUNTIME_IMAGE=ghcr.io/o/node-runtime:24-r1@sha256:abc\nFROM ${RUNTIME_IMAGE}\n',
    );
    expect(readRuntimeBaseRef(dir)).toBe('ghcr.io/o/node-runtime:24-r1@sha256:abc');
  });

  it('strips the quotes a Dockerfile may put around the default', () => {
    writeFileSync(join(dir, 'Dockerfile'), 'ARG RUNTIME_IMAGE="ghcr.io/o/r:1"\n');
    expect(readRuntimeBaseRef(dir)).toBe('ghcr.io/o/r:1');
    writeFileSync(join(dir, 'Dockerfile'), "ARG RUNTIME_IMAGE='ghcr.io/o/r:2'\n");
    expect(readRuntimeBaseRef(dir)).toBe('ghcr.io/o/r:2');
  });

  it('is null for a Dockerfile without the ARG, or with no Dockerfile at all', () => {
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:24-alpine\n# ARG RUNTIME_IMAGE=x\n');
    expect(readRuntimeBaseRef(dir)).toBeNull();
    rmSync(join(dir, 'Dockerfile'));
    expect(readRuntimeBaseRef(dir)).toBeNull();
  });

  it("matches the shipped template's pin", () => {
    expect(readRuntimeBaseRef(fileURLToPath(new URL('../../../carbon', import.meta.url)))).toBe(
      NODE_RUNTIME_IMAGE,
    );
  });
});
