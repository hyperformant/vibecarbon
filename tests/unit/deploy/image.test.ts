import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildLocalImage,
  generateLocalImageTag,
  inspectGitState,
  sideloadCompose,
} from '../../../src/lib/deploy/image.js';
import { PLATFORM_BUILD_FLAG } from '../../../src/lib/deploy/platform.js';

vi.mock('node:child_process', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

// buildLocalImage/sideloadCompose shell out via runCommandAsync (async seam)
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
        buildArgs: { VITE_SUPABASE_URL: 'https://x.example' },
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

describe('sideloadCompose', () => {
  beforeEach(() => {
    vi.mocked(runCommandAsync).mockReset();
    vi.mocked(runCommandAsync).mockResolvedValue('');
  });
  afterEach(() => {
    vi.mocked(runCommandAsync).mockReset();
  });

  it('shells out to a gzipped docker save | ssh ... gunzip | docker load pipeline with pipefail', async () => {
    await sideloadCompose({
      tag: 'vibecarbon-local/myproj:abc-123',
      sshTarget: 'root@138.199.196.128',
    });

    const call = vi.mocked(runCommandAsync).mock.calls[0];
    expect(call[0][0]).toBe('bash');
    expect(call[0][1]).toBe('-c');
    const cmd = call[0][2] as string;
    // Host-key pinned (H-1): accept-new, NOT /dev/null + no. Without an
    // sshKey there's no per-env known_hosts to reference. The transport opts
    // come from SSH_CONNECTION_OPTS (raw-ssh census, run 31961619204) — not
    // asserted as one exact string because ControlPath embeds the runner's
    // home dir.
    expect(
      cmd.startsWith(
        'set -o pipefail && docker save vibecarbon-local/myproj:abc-123 | gzip -1 | ssh ',
      ),
    ).toBe(true);
    expect(cmd.endsWith("root@138.199.196.128 'gunzip | docker load'")).toBe(true);
    expect(cmd).toContain('StrictHostKeyChecking=accept-new');
    expect(cmd).toContain('BatchMode=yes');
    expect(cmd).toContain('ServerAliveInterval=15');
    expect(cmd).toContain('ControlMaster=auto');
    // OpenSSH takes the FIRST value obtained per option: the long-haul dial
    // bound (30) must precede the shared opts' ConnectTimeout=10 to win.
    expect(cmd.indexOf('ConnectTimeout=30')).toBeGreaterThan(-1);
    expect(cmd.indexOf('ConnectTimeout=30')).toBeLessThan(cmd.indexOf('ConnectTimeout=10'));
    // Captured (not inherited) stdio, so runCommandAsync must reject rather
    // than resolve `false` on failure.
    expect(call[1]).toMatchObject({ silent: true });
  });

  it('passes a custom ssh identity file and per-env known_hosts pin when a key is provided', async () => {
    await sideloadCompose({
      tag: 'vibecarbon-local/myproj:abc-123',
      sshTarget: 'root@138.199.196.128',
      sshKey: '/home/op/.vibecarbon/deploy_key_prod',
    });

    const call = vi.mocked(runCommandAsync).mock.calls[0];
    const cmd = call[0][2] as string;
    // key path is shEscaped; host key is pinned to the derived per-env file.
    expect(cmd).toContain("-i '/home/op/.vibecarbon/deploy_key_prod'");
    expect(cmd).toContain('UserKnownHostsFile=/home/op/.vibecarbon/known_hosts_prod');
    expect(cmd).toContain('GlobalKnownHostsFile=/dev/null');
    expect(cmd).toContain('StrictHostKeyChecking=accept-new');
    expect(cmd).not.toContain('UserKnownHostsFile=/dev/null');
    expect(cmd).not.toContain('StrictHostKeyChecking=no');
  });

  it('rethrows ssh failures', async () => {
    const err = new Error('ssh: connect to host: Connection refused');
    vi.mocked(runCommandAsync).mockRejectedValueOnce(err);

    await expect(sideloadCompose({ tag: 'tag', sshTarget: 'root@x' })).rejects.toThrow(
      /Connection refused/,
    );
  });
});
