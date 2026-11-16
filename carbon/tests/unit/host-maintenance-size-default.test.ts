import { beforeEach, describe, expect, it, vi } from 'vitest';

// The production size bound on the compose state file: no injected fileSize, so
// readHostMaintenance asks fs.stat. A file over the parser's limit is never read.

const fsMock = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ default: fsMock, ...fsMock }));

const { readHostMaintenance } = await import('@server/lib/host-maintenance');

beforeEach(() => {
  fsMock.stat.mockReset();
  fsMock.readFile.mockReset();
});

describe('readHostMaintenance, production file size bound', () => {
  it('stats the state file and never reads one over 16384 bytes', async () => {
    fsMock.stat.mockResolvedValue({ size: 16385 });
    const result = await readHostMaintenance({ isDocker: true, isKubernetes: false });
    expect(fsMock.stat).toHaveBeenCalledWith('/host-status/state.json');
    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect(result.servers).toEqual([
      { name: 'this server', reporting: false, rebootRequired: false, since: null, packages: [] },
    ]);
  });

  it('reads a file at the limit', async () => {
    fsMock.stat.mockResolvedValue({ size: 100 });
    fsMock.readFile.mockResolvedValue(
      JSON.stringify({ v: 1, host: 'web-1', rebootRequired: false, since: null, packages: [] })
    );
    const result = await readHostMaintenance({ isDocker: true, isKubernetes: false });
    expect(fsMock.readFile).toHaveBeenCalledWith('/host-status/state.json', 'utf-8');
    expect(result.servers[0]).toMatchObject({ name: 'web-1', reporting: true });
  });
});
