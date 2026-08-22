import { describe, expect, it, vi } from 'vitest';
import {
  isLocalOnlyImageTag,
  transferImageBetweenServers,
} from '../../../src/lib/deploy/compose/index.js';

vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    runCommandAsync: vi.fn().mockResolvedValue(''),
  };
});

const { runCommandAsync } = await import('../../../src/lib/command.js');

describe('isLocalOnlyImageTag', () => {
  it('treats bare project tags as local-only', () => {
    expect(isLocalOnlyImageTag('myproj-app:local')).toBe(true);
    expect(isLocalOnlyImageTag('myproj-db:latest')).toBe(true);
  });

  it('treats registry paths as not local-only', () => {
    expect(isLocalOnlyImageTag('ghcr.io/owner/repo:abc123')).toBe(false);
    expect(isLocalOnlyImageTag('docker.io/library/postgres:15')).toBe(false);
    // Plain "owner/repo" form (Docker Hub shorthand) is also not local-only.
    expect(isLocalOnlyImageTag('library/postgres:15')).toBe(false);
  });

  it('returns false for empty / non-string inputs', () => {
    expect(isLocalOnlyImageTag('')).toBe(false);
    expect(isLocalOnlyImageTag(null as unknown as string)).toBe(false);
    expect(isLocalOnlyImageTag(undefined as unknown as string)).toBe(false);
  });
});

describe('transferImageBetweenServers', () => {
  it('skips entirely when imageRef is a registry path', async () => {
    vi.mocked(runCommandAsync).mockClear();
    await transferImageBetweenServers('1.2.3.4', '5.6.7.8', '/tmp/key', 'ghcr.io/owner/repo:abc');
    expect(runCommandAsync).not.toHaveBeenCalled();
  });

  it('skips when source and dest are identical', async () => {
    vi.mocked(runCommandAsync).mockClear();
    await transferImageBetweenServers('1.2.3.4', '1.2.3.4', '/tmp/key', 'myproj-app:local');
    expect(runCommandAsync).not.toHaveBeenCalled();
  });

  it('runs an SSH-piped gzipped docker save | docker load for local-only tags', async () => {
    vi.mocked(runCommandAsync).mockClear();
    await transferImageBetweenServers('1.2.3.4', '5.6.7.8', '/tmp/key', 'myproj-app:local');

    expect(runCommandAsync).toHaveBeenCalledTimes(1);
    const [argv, options] = vi.mocked(runCommandAsync).mock.calls[0];
    expect(argv[0]).toBe('bash');
    expect(argv[1]).toBe('-c');
    const script = argv[2] as string;
    // SSH out to the source server, pipe to SSH on the destination.
    expect(script).toContain('ssh');
    expect(script).toContain('root@1.2.3.4');
    expect(script).toContain('root@5.6.7.8');
    expect(script).toContain('docker save');
    expect(script).toContain('docker load');
    expect(script).toContain('myproj-app:local');
    // BatchMode must be set (memory: feedback_ssh_batchmode_required).
    expect(script).toContain('BatchMode=yes');
    // gzip on the wire (3-5x reduction for Node images).
    expect(script).toContain('gzip -1');
    expect(script).toContain('gunzip');
    // pipefail so a docker-save / gzip failure isn't masked by ssh exit code.
    expect(script).toContain('pipefail');
    // Generous timeout for cross-region image transfers.
    expect((options as { timeout: number }).timeout).toBeGreaterThanOrEqual(300_000);
  });
});
