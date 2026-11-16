import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { K8sApiError } from '@server/lib/k8s-api';
import { parseHostState, readHostMaintenance } from '@server/lib/host-maintenance';

const read = (name: string) =>
  readFileSync(join(__dirname, '../fixtures/host-state', name), 'utf-8');

const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

describe('parseHostState', () => {
  it('reads a due state', () => {
    expect(parseHostState(read('due.json'))).toEqual({
      host: 'web-1',
      rebootRequired: true,
      since: '2026-11-15T06:42:10Z',
      packages: ['linux-base', 'linux-image-6.8.0-90-generic'],
    });
  });
  it('reads a clear state', () => {
    expect(parseHostState(read('clear.json'))).toEqual({
      host: 'web-1',
      rebootRequired: false,
      since: null,
      packages: [],
    });
  });
  it('caps packages at 20', () => {
    expect(parseHostState(read('many-packages.json'))?.packages).toHaveLength(20);
  });
  it('drops hostile package names and keeps the valid ones', () => {
    expect(parseHostState(read('hostile.json'))).toEqual({
      host: 'web-1',
      rebootRequired: true,
      since: '2026-11-15T06:42:10Z',
      packages: ['curl', 'linux-image-6.8.0-90-generic', 'libc6:amd64'],
    });
  });
  const state = (over: object) =>
    JSON.stringify({ v: 1, host: 'web-1', rebootRequired: false, since: null, packages: [], ...over });
  it('rejects text over 16384 characters', () => {
    expect(parseHostState(state({ host: 'a'.repeat(20000) }))).toBeNull();
    expect(parseHostState(`${state({})}${' '.repeat(16384)}`)).toBeNull();
  });
  it.each(['', '-web', 'we b', 'web<1>', 'a'.repeat(254), '\u001b[31m'])('rejects host %j', (host) => {
    expect(parseHostState(state({ host }))).toBeNull();
  });
  it.each(['yesterday', '2026-11-15 06:42:10', '2026-11-15T06:42:10+00:00', '<b>'])(
    'rejects since %j',
    (since) => {
      expect(parseHostState(state({ since }))).toBeNull();
    }
  );
  it('keeps the package cap after dropping bad names', () => {
    const packages = ['a b', ...Array.from({ length: 25 }, (_, i) => `pkg-${i}`)];
    expect(parseHostState(state({ packages }))?.packages).toHaveLength(20);
  });
  it.each([read('malformed.txt'), '{"v":2}', ''])('returns null for %j', (text) => {
    expect(parseHostState(text)).toBeNull();
  });
});

describe('readHostMaintenance', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('compose with a due state reports the server and the restart', async () => {
    const readFile = vi.fn(async () => read('due.json'));
    const result = await readHostMaintenance({ isDocker: true, readFile });
    expect(readFile).toHaveBeenCalledWith('/host-status/state.json');
    expect(result).toEqual({
      runtime: 'compose',
      envName: null,
      rebootRequired: true,
      since: '2026-11-15T06:42:10Z',
      servers: [
        {
          name: 'web-1',
          reporting: true,
          rebootRequired: true,
          since: '2026-11-15T06:42:10Z',
          packages: ['linux-base', 'linux-image-6.8.0-90-generic'],
        },
      ],
    });
  });

  it('compose with a clear state is not due', async () => {
    const result = await readHostMaintenance({ isDocker: true, readFile: async () => read('clear.json') });
    expect(result).toMatchObject({ runtime: 'compose', rebootRequired: false, since: null });
    expect(result.servers[0]).toMatchObject({ name: 'web-1', reporting: true });
  });

  it('compose with the directory but no state.json is one server not reporting', async () => {
    const readFile = vi.fn(async (p: string) => {
      if (p === '/host-status/state.json') throw enoent();
      return '';
    });
    const result = await readHostMaintenance({
      isDocker: true,
      readFile,
      dirExists: async () => true,
    });
    expect(result.runtime).toBe('compose');
    expect(result.rebootRequired).toBe(false);
    expect(result.servers).toEqual([
      { name: 'this server', reporting: false, rebootRequired: false, since: null, packages: [] },
    ]);
  });

  it('compose with an unparseable state.json is not reporting', async () => {
    const result = await readHostMaintenance({
      isDocker: true,
      readFile: async () => read('malformed.txt'),
    });
    expect(result.servers[0]).toMatchObject({ name: 'this server', reporting: false });
  });

  it('compose without /host-status is runtime none', async () => {
    const result = await readHostMaintenance({
      isDocker: true,
      readFile: async () => {
        throw enoent();
      },
      dirExists: async () => false,
    });
    expect(result).toEqual({
      runtime: 'none',
      envName: null,
      rebootRequired: false,
      since: null,
      servers: [],
    });
  });

  it('compose rethrows a read error that is not a missing file', async () => {
    await expect(
      readHostMaintenance({
        isDocker: true,
        readFile: async () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
      })
    ).rejects.toThrow('EACCES');
  });

  it('neither runtime is none', async () => {
    expect(await readHostMaintenance({})).toMatchObject({ runtime: 'none', servers: [] });
  });

  it('k8s names both nodes, the unannotated one not reporting, and takes the earliest since', async () => {
    const getNodes = async () => ({
      items: [
        { metadata: { name: 'worker-1', annotations: { 'vibecarbon.dev/host-state': read('due.json') } } },
        {
          metadata: {
            name: 'worker-2',
            annotations: {
              'vibecarbon.dev/host-state': JSON.stringify({
                v: 1,
                host: 'worker-2',
                rebootRequired: true,
                since: '2026-11-14T01:00:00Z',
                packages: ['libc6'],
              }),
            },
          },
        },
        { metadata: { name: 'worker-3' } },
      ],
    });
    const result = await readHostMaintenance({ isKubernetes: true, getNodes });
    expect(result.runtime).toBe('kubernetes');
    expect(result.rebootRequired).toBe(true);
    expect(result.since).toBe('2026-11-14T01:00:00Z');
    expect(result.servers.map((s) => [s.name, s.reporting, s.rebootRequired])).toEqual([
      ['worker-1', true, true],
      ['worker-2', true, true],
      ['worker-3', false, false],
    ]);
  });

  it('k8s names a server by its node, not by the reported host', async () => {
    const result = await readHostMaintenance({
      isKubernetes: true,
      getNodes: async () => ({
        items: [{ metadata: { name: 'node-a', annotations: { 'vibecarbon.dev/host-state': read('clear.json') } } }],
      }),
    });
    expect(result.servers[0].name).toBe('node-a');
  });

  it('a Forbidden node list rejects and never reads as not due', async () => {
    await expect(
      readHostMaintenance({
        isKubernetes: true,
        getNodes: async () => {
          throw new K8sApiError(403);
        },
      })
    ).rejects.toBeInstanceOf(K8sApiError);
  });

  it('envName passes a valid VIBECARBON_ENV through', async () => {
    vi.stubEnv('VIBECARBON_ENV', 'prod_1.eu');
    expect((await readHostMaintenance({})).envName).toBe('prod_1.eu');
  });

  it.each(['', 'a b', '-x', '<b>x</b>', 'x'.repeat(101), 'x; rm -rf /'])(
    'envName is null for %j',
    async (value) => {
      vi.stubEnv('VIBECARBON_ENV', value);
      expect((await readHostMaintenance({})).envName).toBeNull();
    }
  );
});
